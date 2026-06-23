"""
Instagram bridge client (unofficial private API via instagrapi).

Drives a personal Instagram account: logs in (reusing a persisted session so we do not re-auth and
trip a challenge every start), RECEIVES inbound DMs, and SENDS replies. Receive defaults to POLLING
(reliable); instagrapi's realtime MQTT/FBNS push is newer and experimental, so it is opt-in via
IG_RECEIVE_MODE=realtime once you have validated it on your account (it falls back to polling if the
realtime API is unavailable in the installed instagrapi version).

SAFETY: this is against Instagram's ToS and at REAL ban risk. Use a DEDICATED account, enable 2FA,
route through a residential/mobile proxy (IG_PROXY), and keep the pacing conservative. See README.md.

All Instagram knowledge lives here. `on_event(dict)` is the one way out: it is called for each inbound
DM ({"type":"message", ...}) and for each login challenge ({"type":"challenge", ...}); app.py wires it
to POST to Jarvis. This file is the only thing that imports instagrapi.
"""
import os
import time
import random
import logging
import threading

from instagrapi import Client
from instagrapi.exceptions import TwoFactorRequired

log = logging.getLogger("ig.client")


def _env(name, default=""):
    return os.environ.get(name, default)


def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class InstagramClient:
    def __init__(self, on_event):
        self.on_event = on_event
        self.username = _env("IG_USERNAME")
        self.password = _env("IG_PASSWORD")
        self.session_file = _env("IG_SESSION_FILE", "/data/ig-session.json")
        self.proxy = _env("IG_PROXY")
        self.receive_mode = _env("IG_RECEIVE_MODE", "poll").lower()
        self.poll_interval = _env_int("IG_POLL_INTERVAL_S", 20)
        self.min_send_interval = _env_int("IG_MIN_SEND_INTERVAL_MS", 4000) / 1000.0
        self.send_jitter = _env_int("IG_SEND_JITTER_MS", 3000) / 1000.0

        self.cl = Client()
        if self.proxy:
            self.cl.set_proxy(self.proxy)  # one proxy for HTTP (and MQTT, in realtime mode)
        # Surface a login challenge to the owner instead of blocking on stdin: store the prompt and
        # wait for /challenge to provide the code (a human types it from WhatsApp).
        self.cl.challenge_code_handler = self._on_challenge_code
        self.cl.change_password_handler = lambda username: None

        self._challenge_code = None
        self._challenge_event = threading.Event()
        self._last_send = 0.0
        self._send_lock = threading.Lock()
        self._seen = set()       # message ids already relayed (dedup, mainly for polling)
        self._seen_order = []     # bounded FIFO of seen ids
        self._started = False

    # ---- login / session -------------------------------------------------

    def login(self):
        if not self.username or not self.password:
            raise RuntimeError("IG_USERNAME / IG_PASSWORD not set - the sidecar is not configured")
        # Reuse a persisted session (device fingerprint + cookies) so we do not log in fresh every
        # start - a fresh login is the main challenge/ban trigger.
        if os.path.exists(self.session_file):
            try:
                self.cl.load_settings(self.session_file)
                self.cl.login(self.username, self.password)  # validate / refresh against saved device
                self.cl.get_timeline_feed()                  # cheap call to confirm the session works
                log.info("logged in from a saved session")
                return
            except Exception as err:  # noqa: BLE001 - any stale-session error falls back to a fresh login
                log.warning("saved session unusable (%s); logging in fresh", err)
        self._fresh_login()
        self._save()

    def _fresh_login(self):
        try:
            self.cl.login(self.username, self.password)
        except TwoFactorRequired:
            code = self._ask_owner("Two-factor code required (from your authenticator app or SMS).")
            self.cl.login(self.username, self.password, verification_code=code)
        log.info("fresh login ok")

    def _save(self):
        try:
            self.cl.dump_settings(self.session_file)
        except Exception as err:  # noqa: BLE001
            log.warning("could not persist the session: %s", err)

    # ---- login challenge handling ---------------------------------------

    def _on_challenge_code(self, username, choice):
        # instagrapi calls this when Instagram demands a code (email/SMS). Ask the owner via WhatsApp.
        return self._ask_owner("Instagram sent a verification code; reply with it.")

    def _ask_owner(self, detail):
        self._challenge_event.clear()
        self._challenge_code = None
        self.on_event({"type": "challenge", "detail": detail})
        # Block this login thread until the owner submits a code via /challenge (5 min ceiling).
        if not self._challenge_event.wait(timeout=300):
            raise RuntimeError("timed out waiting for a challenge code")
        return self._challenge_code

    def submit_code(self, code):
        self._challenge_code = str(code).strip()
        self._challenge_event.set()
        return True

    # ---- receive ---------------------------------------------------------

    def start(self):
        if self._started:
            return
        self._started = True
        target = self._run_realtime if self.receive_mode == "realtime" else self._run_poll
        threading.Thread(target=target, daemon=True).start()

    def _run_poll(self):
        log.info("receiving via polling every %ss", self.poll_interval)
        self._scan(relay=False)  # prime the seen-set so we do not replay history on first start
        while True:
            time.sleep(self.poll_interval)
            try:
                self._scan(relay=True)
            except Exception as err:  # noqa: BLE001 - a poll error must not kill the loop
                log.warning("poll failed: %s", err)

    def _scan(self, relay):
        # Pull the most recent threads and relay any inbound (not-from-me) text we have not seen.
        threads = self.cl.direct_threads(amount=_env_int("IG_POLL_THREADS", 10))
        me = str(self.cl.user_id)
        for th in threads:
            for msg in reversed(getattr(th, "messages", []) or []):
                mid = str(getattr(msg, "id", "") or "")
                if not mid or mid in self._seen:
                    continue
                self._remember_seen(mid)
                if str(getattr(msg, "user_id", "")) == me:
                    continue  # our own message
                text = getattr(msg, "text", None)
                if relay and getattr(msg, "item_type", "text") == "text" and text:
                    user = self._thread_user(th)
                    self.on_event({
                        "type": "message",
                        "threadId": str(th.id),
                        "userId": str(getattr(msg, "user_id", "") or ""),
                        "username": user["username"],
                        "name": user["name"],
                        "text": text,
                    })

    def _run_realtime(self):
        # EXPERIMENTAL: instagrapi's realtime MQTT (and FBNS push) is new; method names may differ by
        # version. Try it; fall back to polling if it is unavailable, so the bridge still works.
        try:
            self.cl.on("message", self._on_realtime_safe)  # event name per instagrapi realtime client
            self._scan(relay=False)                         # prime the seen-set
            self.cl.direct_subscribe()                      # open the MQTT DM subscription
            log.info("receiving via realtime MQTT (experimental)")
            while True:
                time.sleep(60)
        except Exception as err:  # noqa: BLE001
            log.warning("realtime unavailable (%s); falling back to polling", err)
            self._run_poll()

    def _on_realtime_safe(self, msg):
        try:
            self._on_realtime_message(msg)
        except Exception as err:  # noqa: BLE001
            log.warning("realtime handler error: %s", err)

    def _on_realtime_message(self, msg):
        mid = str(getattr(msg, "id", "") or getattr(msg, "item_id", "") or "")
        if mid and mid in self._seen:
            return
        if mid:
            self._remember_seen(mid)
        text = getattr(msg, "text", None)
        if not text:
            return
        user_id = str(getattr(msg, "user_id", "") or "")
        username, name = "", ""
        try:
            if user_id:
                info = self.cl.user_short_gql(int(user_id))
                username = getattr(info, "username", "")
                name = getattr(info, "full_name", "") or username
        except Exception:  # noqa: BLE001 - name enrichment is best-effort
            pass
        self.on_event({
            "type": "message",
            "threadId": str(getattr(msg, "thread_id", "") or ""),
            "userId": user_id,
            "username": username,
            "name": name,
            "text": text,
        })

    def _remember_seen(self, mid):
        self._seen.add(mid)
        self._seen_order.append(mid)
        if len(self._seen_order) > 2000:
            self._seen.discard(self._seen_order.pop(0))

    # ---- send ------------------------------------------------------------

    def send(self, username=None, thread_id=None, user_id=None, text=None):
        if not text:
            return False
        self._pace()
        with self._send_lock:
            try:
                if thread_id:
                    self.cl.direct_send(text, thread_ids=[int(thread_id)])
                else:
                    uid = user_id or (self.cl.user_id_from_username(username) if username else None)
                    if not uid:
                        log.warning("send: could not resolve a recipient")
                        return False
                    self.cl.direct_send(text, user_ids=[int(uid)])
                return True
            except Exception as err:  # noqa: BLE001
                log.warning("send failed: %s", err)
                return False

    def _pace(self):
        # Human-like spacing between sends (mirrors Jarvis's WhatsApp pacing): never two sends closer
        # than min_send_interval, plus a random jitter on top.
        wait = max(0.0, self._last_send + self.min_send_interval - time.monotonic())
        wait += random.random() * self.send_jitter
        if wait > 0:
            time.sleep(wait)
        self._last_send = time.monotonic()

    def threads(self):
        out = []
        try:
            for th in self.cl.direct_threads(amount=_env_int("IG_LIST_THREADS", 15)):
                user = self._thread_user(th)
                msgs = getattr(th, "messages", []) or []
                out.append({
                    "username": user["username"],
                    "name": user["name"],
                    "unread": bool(getattr(th, "unread_count", 0)),
                    "last_text": (getattr(msgs[0], "text", "") or "") if msgs else "",
                })
        except Exception as err:  # noqa: BLE001
            log.warning("threads failed: %s", err)
        return out

    @staticmethod
    def _thread_user(th):
        users = getattr(th, "users", []) or []
        if users:
            u = users[0]
            return {"username": getattr(u, "username", ""), "name": getattr(u, "full_name", "") or getattr(u, "username", "")}
        return {"username": "", "name": ""}
