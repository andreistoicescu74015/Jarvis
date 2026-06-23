# insta/ - Instagram bridge (research + design)

A self-contained spike folder, kept OUTSIDE the formal `docs/` tree on purpose.

**Scope (current): OUTBOUND ONLY.** Goal narrowed to: the owner can **send** Instagram DMs from
WhatsApp (`jarvis ig <person> <message>`). Receiving DMs into WhatsApp was descoped - it was the hard,
risky half (message-loss on restart, an inbound socket on Jarvis, experimental realtime). The earlier
bidirectional design is preserved in git history (commit 75f505d) if it is ever wanted back.

## What's in here

| File | What it is |
|------|------------|
| [`research.md`](research.md) | Deep-research findings (2026-06-23): official vs unofficial, which library, Node vs Python, ban risk. Still fully valid. |
| [`integration-design.md`](integration-design.md) | The original (bidirectional) design sketch. Its inbound/relay/quote-reply sections are SUPERSEDED by the outbound-only build - see the banner at its top. |

## Headline

1. **The official Meta Instagram API cannot do this** (personal P2P): professional account required,
   cannot initiate, 24h window. So the route is the **unofficial** private API. (research.md.)
2. **Base: Python `instagrapi`** (the Node libraries are stale), run as a **sidecar** Jarvis talks to.
3. **Outbound only** keeps it simple and far safer: no inbound socket on Jarvis, no message-loss
   surface, no experimental realtime. The whole anti-ban posture lives in the sidecar.

## How it is wired (as built)

- `src/instagram/sidecar-client.js` - the owner-only `ctx.instagram` capability: `send` / `code` /
  `status` over HTTP to the sidecar; best-effort, null when unconfigured.
- `src/commands/ig.js` - `jarvis ig` (status) / `jarvis ig <person> <message>` (send) / `jarvis ig code
  <value>` (answer a login challenge). Owner-only.
- `insta-sidecar/` - the Python instagrapi service: login + session reuse + `direct_send`, with the
  safety posture (pacing, hourly cap, proxy, truthful status, login retry). See its README.
- Wired in `src/whatsapp-main.js` + `docker-compose.yml` (opt-in: `docker compose --profile instagram
  up`); config in `.env.example`.

## Safety (built in, our side)

- **No inbound socket on Jarvis** (outbound-only) - the smallest possible surface.
- **Mandatory token** - the sidecar refuses to drive an account without `INSTAGRAM_SIDECAR_TOKEN`.
- **Session reuse + optional password-drop** after first login (fewer logins = fewer challenges).
- **Send pacing (under lock) + hourly cap** - anti-ban; **proxy** support.
- **Challenge/2FA** surfaced via `jarvis ig` status and answered with `jarvis ig code` (never auto-bypassed).
- **Owner-only** command.

## Status

- [x] Scope: **outbound-only** (send WhatsApp -> Instagram)
- [x] Route/library: unofficial -> **Python instagrapi sidecar**
- [x] Build: **IMPLEMENTED.** Node side unit-tested green (`npm test`). The Python sidecar talks to the
  real Instagram API and **must be validated standalone first** (Phase 1 in `insta-sidecar/README.md`).
- [ ] Account: a **test account** for now (your call to move to another later; set in `.env`).

## Caveat

`instagrapi` is pinned; the private API drifts and the library moves fast - re-verify at build time.
