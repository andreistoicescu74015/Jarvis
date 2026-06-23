"""
Instagram bridge client - OUTBOUND ONLY (unofficial private API via instagrapi).

Logs into an Instagram account and SENDS DMs on request. It does NOT receive - there is no poll/MQTT
loop and no inbound channel back to Jarvis. The owner sends with `jarvis ig <person> <message>`.

SAFETY (this is the whole point of the sidecar - it carries the anti-ban posture):
  - Session reuse: persist device fingerprint + cookies, so we re-auth rarely (a fresh login is the
    main challenge/ban trigger). After the first login you can run on the session alone (no password).
  - Pacing: a human-like minimum spacing + jitter between sends, applied under the send lock so two
    concurrent sends can never under-space.
  - Hourly cap: a hard backstop on sends per rolling hour, so a bug or a fat-fingered loop can't spray.
  - Proxy: route HTTP through a residential/mobile proxy (IG_PROXY).
  - Challenge/2FA: surfaced via status (pull) and answered with `jarvis ig code` - never auto-bypassed.

This file is the only thing that imports instagrapi; it exposes a tiny intent API (send / submit_code /
status) so the rest of the system never sees raw instagrapi shapes.
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
    def __init__(self):
        self.username = _env("IG_USERNAME")
        self.password = _env("IG_PASSWORD")
        self.session_file = _env("IG_SESSION_FILE", "/data/ig-session.json")
        self.proxy = _env("IG_PROXY")
        self.min_send_interval = _env_int("IG_MIN_SEND_INTERVAL_MS", 4000) / 1000.0
        self.send_jitter = _env_int("IG_SEND_JITTER_MS", 3000) / 1000.0
        self.max_per_hour = _env_int("IG_MAX_SENDS_PER_HOUR", 60)
        self.login_retry_s = _env_int("IG_LOGIN_RETRY_S", 120)

        self.cl = Client()
        if self.proxy:
            self.cl.set_proxy(self.proxy)
        self.cl.challenge_code_handler = self._on_challenge_code
        self.cl.change_password_handler = lambda username: None

        # state: starting | logged_in | challenge_required | login_failed
        self.state = "starting"
        self.detail = ""
        self._challenge_code = None
        self._challenge_event = threading.Event()
        self._send_lock = threading.Lock()
        self._last_send = 0.0
        self._sent_times = []   # epoch seconds of recent sends (rolling hourly cap)
        self._uid_cache = {}     # username(lower) -> user_id
        self._boot_lock = threading.Lock()
        self._booted = False

    # ---- login (background, with retry) ---------------------------------

    def start(self):
        with self._boot_lock:
            if self._booted:
                return
            self._booted = True
        threading.Thread(target=self._login_loop, daemon=True).start()

    def _login_loop(self):
        while True:
            try:
                self._login_once()
                self.state, self.detail = "logged_in", ""
                log.info("logged in as %s", self.username)
                return
            except Exception as err:  # noqa: BLE001 - keep the bridge alive and retry rather than wedge
                self.state, self.detail = "login_failed", str(err)
                log.error("login failed: %s; retrying in %ss", err, self.login_retry_s)
                time.sleep(self.login_retry_s)

    def _login_once(self):
        if not self.username:
            raise RuntimeError("IG_USERNAME not set")
        have_session = os.path.exists(self.session_file)
        if not have_session and not self.password:
            raise RuntimeError("no saved session and no IG_PASSWORD to log in with")
        if have_session:
            try:
                self.cl.load_settings(self.session_file)
                if self.password:
                    self.cl.login(self.username, self.password)  # refresh against the saved device
                self.cl.get_timeline_feed()                      # cheap call: confirm the session works
                return
            except Exception as err:  # noqa: BLE001 - a stale session falls back to a fresh login
                log.warning("saved session unusable (%s); logging in fresh", err)
        if not self.password:
            raise RuntimeError("saved session invalid and no IG_PASSWORD to re-auth")
        try:
            self.cl.login(self.username, self.password)
        except TwoFactorRequired:
            code = self._ask_code("Two-factor code required (authenticator app or SMS).")
            self.cl.login(self.username, self.password, verification_code=code)
        self._save()

    def _save(self):
        try:
            self.cl.dump_settings(self.session_file)
        except Exception as err:  # noqa: BLE001
            log.warning("could not persist the session: %s", err)

    # ---- challenge (pull-based: status shows it, /challenge answers it) --

    def _on_challenge_code(self, username, choice):
        return self._ask_code("Instagram sent a verification code; submit it with `jarvis ig code`.")

    def _ask_code(self, detail):
        self._challenge_event.clear()
        self._challenge_code = None
        self.state, self.detail = "challenge_required", detail
        log.warning("challenge required: %s", detail)
        if not self._challenge_event.wait(timeout=600):  # 10 min for the owner to answer
            raise RuntimeError("timed out waiting for a challenge code")
        self.state = "starting"
        return self._challenge_code

    def submit_code(self, code):
        if self.state != "challenge_required":
            return False  # nothing is waiting - ignore a stray/late code
        self._challenge_code = str(code).strip()
        self._challenge_event.set()
        return True

    # ---- send ------------------------------------------------------------

    def send(self, username, text):
        if not username or not text:
            return {"ok": False, "status": "bad_args"}
        if self.state != "logged_in":
            status = "challenge_required" if self.state == "challenge_required" else "not_logged_in"
            return {"ok": False, "status": status, "detail": self.detail}
        with self._send_lock:  # serialize: pacing + cap + send are one unit, so sends never under-space
            if not self._within_cap():
                return {"ok": False, "status": "rate_capped"}
            self._pace()
            try:
                uid = self._resolve(username)
                if not uid:
                    return {"ok": False, "status": "unknown_user"}
                self.cl.direct_send(text, user_ids=[uid])
                self._record_send()
                return {"ok": True}
            except Exception as err:  # noqa: BLE001
                log.warning("send failed: %s", err)
                return {"ok": False, "status": "error", "detail": str(err)}

    def _resolve(self, username):
        u = username.lower().lstrip("@")
        if u in self._uid_cache:
            return self._uid_cache[u]
        try:
            uid = int(self.cl.user_id_from_username(u))  # one lookup per username, then cached
            self._uid_cache[u] = uid
            return uid
        except Exception as err:  # noqa: BLE001 - unknown / private / lookup failure
            log.warning("could not resolve username %s: %s", u, err)
            return None

    def _within_cap(self):
        cutoff = time.time() - 3600
        self._sent_times = [t for t in self._sent_times if t >= cutoff]
        return len(self._sent_times) < self.max_per_hour

    def _record_send(self):
        self._sent_times.append(time.time())
        self._last_send = time.monotonic()

    def _pace(self):
        # Human-like spacing: never two sends closer than min_send_interval, plus jitter on top.
        wait = max(0.0, self._last_send + self.min_send_interval - time.monotonic())
        wait += random.random() * self.send_jitter
        if wait > 0:
            time.sleep(wait)

    # ---- status ----------------------------------------------------------

    def status(self):
        cutoff = time.time() - 3600
        recent = len([t for t in self._sent_times if t >= cutoff])
        return {"state": self.state, "account": self.username, "detail": self.detail, "sent_last_hour": recent}
