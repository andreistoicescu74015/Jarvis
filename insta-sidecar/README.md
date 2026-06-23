# insta-sidecar

A small Python service that drives a personal Instagram account via the unofficial **instagrapi**
library and bridges its DMs to Jarvis. It receives inbound DMs and pushes them to Jarvis, and sends
replies Jarvis asks it to. Jarvis relays inbound DMs into the owner's WhatsApp and sends replies via
the owner-only `jarvis ig` command. Design + research: see the repo's `insta/` folder.

> **UNOFFICIAL + ban risk.** This automates a personal account against Instagram's ToS. Enforcement is
> account-level (challenge, then suspension/ban), not lawsuits. Use a **dedicated** account, enable
> **2FA**, route through a **residential/mobile proxy**, and keep pacing conservative. You accept the
> risk to the configured account.

## Wire protocol

Jarvis -> sidecar (token-gated, `Authorization: Bearer <INSTAGRAM_SIDECAR_TOKEN>`):
- `POST /send`      `{ "username"?, "thread_id"?, "user_id"?, "text" }` -> `{ "ok": bool }`
- `POST /threads`   `{}` -> `{ "threads": [{ "username", "name", "unread", "last_text" }] }`
- `POST /challenge` `{ "code": "123456" }` -> `{ "ok": bool }`  (answer a login challenge)
- `GET  /health`    -> `{ "ok": true }`  (unauthenticated)

sidecar -> Jarvis (`POST $JARVIS_INGEST_URL`, same bearer token):
- inbound DM:    `{ "type": "message", "threadId", "userId", "username", "name", "text" }`
- login prompt:  `{ "type": "challenge", "detail": "..." }`

## Configuration (env)

| Var | Meaning |
|-----|---------|
| `IG_USERNAME` / `IG_PASSWORD` | the account it drives (use a DEDICATED account) |
| `IG_PROXY` | residential/mobile proxy, e.g. `http://user:pass@host:port` (recommended) |
| `IG_SESSION_FILE` | where the session + device fingerprint persist (default `/data/ig-session.json`) |
| `IG_RECEIVE_MODE` | `poll` (default, reliable) or `realtime` (experimental MQTT push) |
| `IG_POLL_INTERVAL_S` | poll cadence in poll mode (default 20) |
| `IG_MIN_SEND_INTERVAL_MS` / `IG_SEND_JITTER_MS` | human-like send pacing (anti-ban) |
| `INSTAGRAM_SIDECAR_TOKEN` | shared secret for both directions |
| `JARVIS_INGEST_URL` | where to push inbound events (compose: `http://jarvis:8765/ig/inbound`) |
| `IG_SIDECAR_PORT` | HTTP port to listen on (default 8099) |

## Receive: polling vs realtime

Default is **polling** - it pulls recent threads every `IG_POLL_INTERVAL_S` and relays new inbound
text, deduped by message id. It is reliable and version-proof. **Realtime** (`IG_RECEIVE_MODE=realtime`)
uses instagrapi's MQTT push for instant delivery, but that API is new/experimental (see `insta/`); the
code falls back to polling if it is unavailable. Start on polling; switch to realtime only after you
have confirmed it on your account.

## Phase 1 - validate before trusting it (do this on a throwaway account)

The Node side of the bridge is unit-tested, but this sidecar talks to the real Instagram private API,
which cannot be tested offline. Validate it standalone first:

```bash
cd insta-sidecar
python -m venv .venv && . .venv/bin/activate     # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt

export IG_USERNAME=throwaway_account              # NOT your main account
export IG_PASSWORD=...
export INSTAGRAM_SIDECAR_TOKEN=dev-secret
export IG_SESSION_FILE=./ig-session.json
# export IG_PROXY=http://user:pass@host:port      # recommended even for the test
python app.py
```

Then, from another terminal, confirm send + receive:

```bash
# health
curl localhost:8099/health
# send a DM to someone (use a second account you control)
curl -X POST localhost:8099/send -H 'authorization: Bearer dev-secret' \
     -H 'content-type: application/json' -d '{"username":"your_other_handle","text":"bridge test"}'
# reply to that DM from the other account, then within ~20s you should see the sidecar log a relayed
# "message" event (set JARVIS_INGEST_URL to a local listener, e.g. a `nc -l 8765`, to see the payload).
```

If a login challenge appears, the sidecar emits a `challenge` event and waits up to 5 minutes; submit
the code with `curl -X POST localhost:8099/challenge -H 'authorization: Bearer dev-secret' -H
'content-type: application/json' -d '{"code":"123456"}'`. Once this works, wire it to Jarvis via Docker
(`docker compose --profile instagram up`) and the bridge is live: inbound DMs land in your WhatsApp and
`jarvis ig <person> <message>` sends.

## Notes

- Flask's built-in server is fine for a single-user personal bridge; it is internal-network only.
- `instagrapi` is pinned in `requirements.txt`; bump deliberately - the private API drifts and the
  library moves fast.
