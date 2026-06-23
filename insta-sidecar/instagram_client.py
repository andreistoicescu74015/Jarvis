"""
Instagram bridge client - OUTBOUND ONLY (unofficial private API via instagrapi).

Logs into an Instagram account and SENDS DMs on request. It does NOT receive - there is no poll/MQTT
loop and no inbound channel back to Jarvis. The owner sends with `jarvis ig <person> <message>`.

SAFETY (this is the whole point of the sidecar - it carries the anti-ban posture):
  - Session reuse: persist device fingerprint + cookies; validate WITHOUT a full re-login, and only
    fall back to a fresh login when the session is genuinely dead (LoginRequired) - never on a network
    blip. A fresh login is the main challenge/ban trigger.
  - Login backoff: a wrong password / unresolved challenge is TERMINAL (we never hammer Instagram with
    repeated logins - the #1 ban signal); transient/network failures retry with exponential backoff.
  - Pacing: a human-like minimum spacing + jitter between sends, under the send lock so two concurrent
    sends can never under-space. A challenge raised mid-send never blocks the lock (it aborts the send
    and re-logs-in in the background).
  - Hourly cap: a hard backstop (IG_MAX_SENDS_PER_HOUR) so a bug or a loop can't spray DMs.
  - Proxy: route HTTP through a residential/mobile proxy (IG_PROXY).
  - Challenge/2FA: surfaced via status (pull) and answered with `jarvis ig code` - never auto-bypassed,
    and the account password is never auto-rotated.

This file is the only thing that imports instagrapi; it exposes a tiny intent API (send / submit_code /
status) so the rest of the system never sees raw instagrapi shapes or raw error strings.
"""
import os
import time
import random
import logging
import threading

from instagrapi import Client
from instagrapi.exceptions import LoginRequired, BadPassword, ChallengeRequired, TwoFactorRequired

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
        self.max_text_len = _env_int("IG_MAX_TEXT_LEN", 2000)
        self.login_retry_s = _env_int("IG_LOGIN_RETRY_S", 120)
        self.login_max_backoff_s = _env_int("IG_LOGIN_MAX_BACKOFF_S", 1800)
        self.uid_cache_ttl = _env_int("IG_UID_CACHE_TTL_S", 21600)

        self.cl = Client()
        if self.proxy:
            self.cl.set_proxy(self.proxy)
        self.cl.challenge_code_handler = self._on_challenge_code
        # Deliberately refuse to auto-change the account password on a PASSWORD_RESET challenge
        # (returning None aborts that step) - the bot must never rotate the owner's password.
        self.cl.change_password_handler = lambda username: None

        # state: starting | logged_in | challenge_required | login_failed
        self.state = "starting"
        self.detail = ""
        self._login_phase = False        # True only while a login attempt is actively running
        self._challenge_code = None
        self._challenge_event = threading.Event()
        self._send_lock = threading.Lock()
        self._login_thread_lock = threading.Lock()
        self._logging_in = False
        self._last_send = 0.0
        self._sent_times = []            # epoch seconds of recent sends (rolling hourly cap)
        self._uid_cache = {}             # username(lower) -> (user_id, fetched_monotonic)
        self._boot_lock = threading.Lock()
        self._booted = False

    # ---- login (background; permanent failures are terminal, transient back off) ----

    def start(self):
        with self._boot_lock:
            if self._booted:
                return
            self._booted = True
        self._spawn_login()

    def _spawn_login(self):
        # At most one login thread at a time (a mid-send challenge can ask for one too).
        with self._login_thread_lock:
            if self._logging_in:
                return
            self._logging_in = True
        threading.Thread(target=self._login_loop, daemon=True).start()

    def _login_loop(self):
        backoff = self.login_retry_s
        try:
            while True:
                self._login_phase = True
                try:
                    self._login_once()
                    self.state, self.detail = "logged_in", ""
                    log.info("logged in as %s", self.username)
                    return
                except (BadPassword, ChallengeRequired) as err:
                    # Permanent: never hammer Instagram with repeated logins (the #1 ban signal). Stop
                    # and wait for the operator; the owner sees the state via `jarvis ig`.
                    self.state, self.detail = "login_failed", type(err).__name__
                    log.error("login failed permanently (%s) - not retrying; fix the account/credentials", type(err).__name__)
                    return
                except Exception as err:  # noqa: BLE001 - transient (network/proxy): back off and retry
                    self.state, self.detail = "login_failed", "temporary login error"
                    wait = min(backoff, self.login_max_backoff_s) + random.random() * 30
                    log.error("login failed (%s); retrying in ~%ds", err, int(wait))
                finally:
                    self._login_phase = False
                time.sleep(wait)
                backoff = min(backoff * 2, self.login_max_backoff_s)
        finally:
            with self._login_thread_lock:
                self._logging_in = False

    def _login_once(self):
        if not self.username:
            raise RuntimeError("IG_USERNAME not set")
        have_session = os.path.exists(self.session_file)
        if not have_session and not self.password:
            raise RuntimeError("no saved session and no IG_PASSWORD to log in with")
        if have_session:
            try:
                self.cl.load_settings(self.session_file)  # loads the device fingerprint + cookies
                self.cl.get_timeline_feed()               # validate the session WITHOUT a full re-login
                return
            except LoginRequired:
                log.warning("saved session expired; logging in fresh (device fingerprint preserved)")
            # Any other error (network/proxy) bubbles to the retry loop - never nuke a session on a blip.
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
        if not self._login_phase:
            # A challenge raised DURING a send: do NOT block the send lock for minutes. Flag it, kick a
            # background re-login (which block-waits for the code in the login phase), and abort the send.
            self.state, self.detail = "challenge_required", "Instagram asked to confirm a login."
            self._spawn_login()
            raise RuntimeError("challenge required mid-send")
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
        if len(text) > self.max_text_len:
            return {"ok": False, "status": "too_long"}
        if self.state != "logged_in":
            status = "challenge_required" if self.state == "challenge_required" else "not_logged_in"
            return {"ok": False, "status": status}
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
            except Exception as err:  # noqa: BLE001 - keep the raw error in the log only (never leak to chat)
                log.warning("send failed: %s", err)
                # A mid-send challenge flips state to challenge_required (see _on_challenge_code).
                return {"ok": False, "status": "challenge_required" if self.state == "challenge_required" else "error"}

    def _resolve(self, username):
        u = username.lower().lstrip("@")
        hit = self._uid_cache.get(u)
        if hit and (time.monotonic() - hit[1]) < self.uid_cache_ttl:
            return hit[0]
        try:
            uid = int(self.cl.user_id_from_username(u))  # one lookup per username, cached with a TTL
            self._uid_cache[u] = (uid, time.monotonic())
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

    # ---- status (lock-free: an atomic list() snapshot, so no cross-thread race) ----

    def status(self):
        times = list(self._sent_times)  # list() of a list is atomic under the GIL - no torn read
        cutoff = time.time() - 3600
        recent = sum(1 for t in times if t >= cutoff)
        return {"state": self.state, "account": self.username, "detail": self.detail, "sent_last_hour": recent}
