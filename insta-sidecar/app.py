"""
HTTP facade for the Instagram bridge sidecar.

Jarvis calls this service: POST /send, POST /threads, POST /challenge. The sidecar PUSHES inbound DMs
and login challenges back to Jarvis (JARVIS_INGEST_URL). Everything is token-gated and meant for the
internal Docker network only - do not publish these ports to the host.

The IG login + receive loop runs in a background thread so the HTTP server is up immediately and can
answer a /challenge that login is blocked on (the owner types the code from WhatsApp).
"""
import os
import logging
import threading

import requests
from flask import Flask, request, jsonify

from instagram_client import InstagramClient

logging.basicConfig(
    level=os.environ.get("IG_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("ig.app")

TOKEN = os.environ.get("INSTAGRAM_SIDECAR_TOKEN", "")
INGEST_URL = os.environ.get("JARVIS_INGEST_URL", "")
PORT = int(os.environ.get("IG_SIDECAR_PORT", "8099"))

app = Flask(__name__)


def push_to_jarvis(event):
    """The sidecar's one way out: POST an inbound DM / challenge event to Jarvis (best-effort)."""
    if not INGEST_URL:
        log.warning("no JARVIS_INGEST_URL; dropping a %s event", event.get("type"))
        return
    try:
        requests.post(
            INGEST_URL,
            json=event,
            headers={"authorization": f"Bearer {TOKEN}"} if TOKEN else {},
            timeout=10,
        )
    except Exception as err:  # noqa: BLE001 - a push failure must not crash the receive loop
        log.warning("push to Jarvis failed: %s", err)


client = InstagramClient(on_event=push_to_jarvis)


@app.before_request
def _guard():
    if request.path == "/health":
        return None
    if TOKEN and request.headers.get("authorization") != f"Bearer {TOKEN}":
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return None


@app.post("/send")
def send():
    body = request.get_json(silent=True) or {}
    ok = client.send(
        username=body.get("username"),
        thread_id=body.get("thread_id"),
        user_id=body.get("user_id"),
        text=body.get("text"),
    )
    return jsonify({"ok": bool(ok)})


@app.post("/threads")
def threads():
    return jsonify({"threads": client.threads()})


@app.post("/challenge")
def challenge():
    body = request.get_json(silent=True) or {}
    return jsonify({"ok": bool(client.submit_code(body.get("code", "")))})


@app.get("/health")
def health():
    return jsonify({"ok": True})


def _boot():
    try:
        client.login()
        client.start()
        log.info("instagram bridge ready")
    except Exception as err:  # noqa: BLE001 - log and stay up so /health and /challenge keep working
        log.error("instagram bridge failed to start: %s", err)


if __name__ == "__main__":
    if not os.environ.get("IG_USERNAME"):
        log.warning("IG_USERNAME not set - the Instagram sidecar is not configured; idling. Set it to enable the bridge.")
    else:
        threading.Thread(target=_boot, daemon=True).start()
    # threaded=True so a /challenge request is served while the boot thread is blocked inside login().
    app.run(host="0.0.0.0", port=PORT, threaded=True)
