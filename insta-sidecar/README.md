# insta-sidecar (outbound only)

A small Python service that logs into an Instagram account via the unofficial **instagrapi** library
and **sends DMs** on Jarvis's behalf. It is OUTBOUND only - it does not receive DMs and has no channel
back into Jarvis. The owner sends with the owner-only `jarvis ig <person> <message>`. Design + research:
see the repo's `insta/` folder.

> **UNOFFICIAL + ban risk.** This automates an account against Instagram's ToS. Enforcement is
> account-level (challenge, then suspension), not lawsuits. Use a **test/dedicated** account while
> trying it. The sidecar carries the safety posture below; you accept the residual risk.

## Wire protocol (Jarvis -> sidecar; token-gated)

All requests need `Authorization: Bearer <INSTAGRAM_SIDECAR_TOKEN>` (the token is **mandatory** - the
sidecar refuses to drive an account without one). Internal network only; do not publish the port.

- `POST /send`      `{ "username"?, "thread_id"?, "text" }` -> `{ "ok": bool, "status"?, "detail"? }`
  - target by `username` (a 1:1 DM) OR `thread_id` (an existing thread - a GROUP or a 1:1).
  - `status` on failure: `challenge_required`, `not_logged_in`, `rate_capped`, `unknown_user`, `too_long`, `error`.
- `POST /threads`   `{ "amount"?: 20 }` -> `{ "ok", "threads": [{ "thread_id", "title", "is_group", "count" }] }`
- `POST /challenge` `{ "code": "123456" }` -> `{ "ok": bool }`  (answer a login challenge)
- `POST /status`    `{}` -> `{ "state", "account", "detail", "sent_last_hour" }`
  - `state`: `starting | logged_in | challenge_required | login_failed | disabled`.
- `GET  /health`    -> `{ "ok": bool, "state" }`  (unauthenticated; `ok:true` only once logged in)

## Safety posture (what the sidecar enforces)

- **Session reuse** - persists the device fingerprint + cookies to `IG_SESSION_FILE`, so it re-auths
  rarely (a fresh login is the main challenge/ban trigger). After the first login you can drop the
  password (below) and run on the session alone.
- **Send pacing** - a minimum spacing + jitter between sends, applied under a lock so concurrent
  sends can never under-space.
- **Hourly cap** - a hard backstop (`IG_MAX_SENDS_PER_HOUR`) so a bug or a loop can't spray DMs.
- **Proxy** - routes HTTP through `IG_PROXY` (use a residential/mobile proxy).
- **Mandatory token** + no inbound socket on Jarvis at all (outbound-only design = tiny surface).
- **Login retry** with backoff; truthful `/status` + `/health` (no false-healthy).

## Configuration (env)

| Var | Meaning |
|-----|---------|
| `IG_USERNAME` / `IG_PASSWORD` | the account it drives. After first login you can REMOVE the password and run on the session. |
| `IG_PROXY` | residential/mobile proxy, e.g. `http://user:pass@host:port` (recommended) |
| `IG_SESSION_FILE` | session + device fingerprint path (default `/data/ig-session.json`) |
| `IG_MIN_SEND_INTERVAL_MS` / `IG_SEND_JITTER_MS` | send pacing |
| `IG_MAX_SENDS_PER_HOUR` | rolling-hour send cap (default 60) |
| `INSTAGRAM_SIDECAR_TOKEN` | shared secret - **required** |
| `IG_SIDECAR_PORT` | HTTP port (default 8099) |

Advanced (sensible defaults; rarely changed): `IG_LOGIN_RETRY_S` (base login backoff, 120),
`IG_LOGIN_MAX_BACKOFF_S` (max login backoff, 1800), `IG_UID_CACHE_TTL_S` (username->id cache TTL,
21600), `IG_MAX_TEXT_LEN` (max DM length, 2000), `IG_LOG_LEVEL` (INFO). A wrong password or an
unresolvable challenge is **terminal** - the sidecar stops retrying (it will not hammer Instagram) and
shows `login_failed` / `challenge_required` via `jarvis ig`; fix the account and restart.

## Phase 1 - validate standalone first (on a test account)

The Node side is unit-tested, but this sidecar talks to the real Instagram private API, which cannot be
tested offline. Validate it before wiring it to Jarvis:

```bash
cd insta-sidecar
python -m venv .venv && . .venv/bin/activate     # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt

export IG_USERNAME=test_account
export IG_PASSWORD=...
export INSTAGRAM_SIDECAR_TOKEN=dev-secret
export IG_SESSION_FILE=./ig-session.json
# export IG_PROXY=http://user:pass@host:port      # recommended even for the test
python app.py
```

From another terminal, use the bundled `igctl.py` helper (it sends the right `Bearer` header for you,
so you don't fight curl/PowerShell quoting). Set the SAME token in this shell first:

```bash
export INSTAGRAM_SIDECAR_TOKEN=dev-secret          # (Windows PowerShell: $env:INSTAGRAM_SIDECAR_TOKEN="dev-secret")
python igctl.py status                              # watch for "logged_in"
python igctl.py send your_other_handle "bridge test"   # send a DM to a second account you control
python igctl.py code 123456                         # only if status shows "challenge_required"

# groups: list threads to find a group's thread_id, then send to it
python igctl.py list                                # recent threads + GROUPS, each with its thread_id
python igctl.py sendto 340282366000000000 "hi group"   # send to a thread/group by its thread_id
```

A send that returns `{"ok": true}` means the bridge works (for a 1:1 or a group).

Once a send lands, wire it to Jarvis (next section). After the first successful login you can remove
`IG_PASSWORD` and rely on the persisted session.

## Run under Docker (auto-login)

In production you do NOT run igctl - the sidecar logs in **automatically** when the container starts.
With `IG_USERNAME` / `IG_PASSWORD` and `INSTAGRAM_SIDECAR_TOKEN` in `.env`:

```bash
docker compose --profile instagram up -d --build
```

It logs in on boot and persists the session to the `jarvis-insta-data` volume, so every later restart
reconnects with **no login**. Check it from WhatsApp with `jarvis ig`, or from `docker ps` (the
container is `healthy` only once logged in). If Instagram asks for a code on the first boot, `jarvis ig`
shows `challenge_required` - answer it with `jarvis ig code <value>`. A wrong password / unresolvable
challenge shows `login_failed` and the sidecar stops retrying (it won't hammer Instagram); fix `.env`
and `docker compose --profile instagram up -d` again.

Tip: to drop the `--profile instagram` flag, set `COMPOSE_PROFILES=instagram` in `.env` - then plain
`docker compose up` starts the sidecar too.

### Optional: reuse your Phase-1 login (skip the first challenge, same device)

A fresh login from the container is a new "device" to Instagram. To reuse the exact session + device
from Phase 1 (challenge-free first boot, lower ban risk), seed it into the volume once - after a first
`docker compose --profile instagram up -d` has created the volume:

```powershell
.\insta-sidecar\seed-session.ps1
docker compose --profile instagram restart insta-sidecar
```

(Manual equivalent: copy `insta-sidecar/ig-session.json` to `/data/ig-session.json` inside the
`*insta-data` volume.)

## Notes

- Flask's built-in server is fine for a single-user personal bridge; it is internal-network only.
- `instagrapi` is pinned in `requirements.txt`; bump deliberately - the private API drifts.
