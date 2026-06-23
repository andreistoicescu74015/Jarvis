# insta/ - Instagram bridge (research + design)

A self-contained spike folder, kept OUTSIDE the formal `docs/` tree on purpose.

**Scope (current): SEND + READ-ON-DEMAND.** The owner can **send** Instagram DMs/groups from WhatsApp
(`jarvis ig <person> <message>`) and **read** a conversation on request (`jarvis ig read <person|n>`) -
enough for back-and-forth without the Instagram app. What stays descoped is the BACKGROUND push/relay
of incoming DMs (the hard, risky half: message-loss on restart, an inbound socket on Jarvis,
experimental realtime) - reading is a pull, on demand, so it avoids all of that. The earlier
bidirectional/push design is preserved in git history (commit 75f505d) if it is ever wanted back.

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
- `src/commands/ig.js` - `jarvis ig` (status) / `jarvis ig read <person|n> [count]` (read a
  conversation, on demand) / `jarvis ig <person> <message>` (DM) / `jarvis ig list` + `jarvis ig to <n>
  <message>` (groups + DMs by number) / `jarvis ig code <value>` (login challenge). Owner-only.
- `insta-sidecar/` - the Python instagrapi service: login + session reuse + `direct_send`, with the
  safety posture (pacing, hourly cap, proxy, truthful status, login retry). See its README.
- Wired in `src/whatsapp-main.js` + `docker-compose.yml` (part of the stack: a plain `docker compose
  up` starts it too); config in `.env.example`. The sidecar **auto-logs-in on container start** (session persists in
  the volume; `docker ps` shows `healthy` only once logged in); a first-boot login challenge is answered
  from WhatsApp with `jarvis ig code <value>`. Optional `insta-sidecar/seed-session.ps1` reuses the
  Phase-1 session for a challenge-free first boot.

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
