"""
HTTP facade for the OUTBOUND Instagram bridge sidecar.

Jarvis calls this service: POST /send, POST /challenge, POST /status. There is NO inbound channel back
to Jarvis - the bridge only sends. Everything except /health is token-gated; the token is MANDATORY
(the service refuses to drive an account without one). Internal Docker network only - do not publish
this port to the host.

The IG login runs in a background thread (with retry) so the HTTP server is up immediately and can
answer a /challenge that login is blocked on (the owner submits the code from WhatsApp via `jarvis ig
code`, discovered through `jarvis ig` status).
"""
import os
import logging

from flask import Flask, request, jsonify

from instagram_client import InstagramClient

logging.basicConfig(
    level=os.environ.get("IG_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("ig.app")

TOKEN = os.environ.get("INSTAGRAM_SIDECAR_TOKEN", "")
PORT = int(os.environ.get("IG_SIDECAR_PORT", "8099"))
IG_ENABLED = bool(os.environ.get("IG_USERNAME"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # refuse oversized request bodies (a DM payload is tiny)
# Only create/drive the account when BOTH an account and a token are configured - never run insecurely.
client = InstagramClient() if (IG_ENABLED and TOKEN) else None


@app.before_request
def _guard():
    if request.path == "/health":
        return None
    if not TOKEN:  # mandatory shared secret - refuse to serve the bridge without one
        return jsonify({"ok": False, "error": "sidecar token not configured"}), 503
    if request.headers.get("authorization") != f"Bearer {TOKEN}":
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return None


@app.post("/send")
def send():
    if not client:
        return jsonify({"ok": False, "status": "disabled"})
    body = request.get_json(silent=True) or {}
    return jsonify(client.send(username=body.get("username"), thread_id=body.get("thread_id"), text=body.get("text")))


@app.post("/threads")
def threads():
    if not client:
        return jsonify({"ok": False, "status": "disabled"})
    body = request.get_json(silent=True) or {}
    return jsonify(client.threads(amount=int(body.get("amount", 20))))


@app.post("/messages")
def messages():
    if not client:
        return jsonify({"ok": False, "status": "disabled"})
    body = request.get_json(silent=True) or {}
    return jsonify(client.messages(username=body.get("username"), thread_id=body.get("thread_id"), amount=body.get("amount", 10)))


@app.post("/challenge")
def challenge():
    if not client:
        return jsonify({"ok": False})
    body = request.get_json(silent=True) or {}
    return jsonify({"ok": bool(client.submit_code(body.get("code", "")))})


@app.post("/status")
def status():
    if not client:
        return jsonify({"state": "disabled"})
    return jsonify(client.status())


@app.get("/health")
def health():
    # Truthful: healthy only once logged in; reports the state for debugging. 503 otherwise so an
    # orchestrator does not treat a not-logged-in / failed bridge as ready.
    if not client:
        return jsonify({"ok": True, "state": "disabled"})
    state = client.status()["state"]
    ok = state == "logged_in"
    return jsonify({"ok": ok, "state": state}), (200 if ok else 503)


if __name__ == "__main__":
    if not IG_ENABLED:
        log.warning("IG_USERNAME not set - the Instagram sidecar is idle (bridge disabled).")
    elif not TOKEN:
        log.error("INSTAGRAM_SIDECAR_TOKEN not set - refusing to run the bridge insecurely. Set a shared secret.")
    else:
        client.start()
    # threaded=True so a /challenge request is served while the login thread is blocked waiting for it.
    app.run(host="0.0.0.0", port=PORT, threaded=True)
