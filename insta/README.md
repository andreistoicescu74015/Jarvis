# insta/ - Instagram DM bridge (research + design)

A self-contained spike folder, kept OUTSIDE the formal `docs/` tree on purpose. Goal: let the
owner read and answer Instagram DMs from inside WhatsApp via Jarvis, so the Instagram app can be
dropped for messaging. Nothing here is built yet - this is a decision record + a forward design.

## What's in here

| File | What it is |
|------|------------|
| [`research.md`](research.md) | Deep-research findings (2026-06-23), multi-source, adversarially fact-checked, with citations. Answers: official vs unofficial, which library, Node vs Python, ban risk. |
| [`integration-design.md`](integration-design.md) | How a bridge would slot into Jarvis - the sidecar, the Node client, the `ig` command, thread routing, anti-ban reuse, env wiring. Mirrors the existing WhatsApp adapter patterns. |

## Headline (read this first)

1. **The official Meta Instagram API cannot do this.** Every official path needs an Instagram
   *professional* account, *cannot* start a conversation (the other person must message you first),
   and confines replies to a 24-hour window. It is a customer-care tool, not free friend-to-friend
   chat. Converting your account to professional does not rescue it. (See research.md, findings 1-2.)

2. **The only realistic route is the unofficial private API** - the Instagram analogue of how Jarvis
   already drives WhatsApp via Baileys.

3. **Best base: Python `instagrapi`** (actively maintained, full DM read+send, built-in realtime
   receive). The Node libraries are stale. So the clean shape is a **Python `instagrapi` sidecar**
   process that Jarvis (Node 24) talks to over local HTTP - not in-process Node. (Findings 3-6.)

4. **Ban risk is real and tightening.** This is the crux decision for you - see below.

## The one decision only you can make: which Instagram account

Your stated goal ("drop the app, keep my real conversations") points at your **main** account - a
dedicated account would not have your existing threads with friends. But the safest technical advice
is a **dedicated** account, because a private-API login can trigger `challenge_required` (captcha /
phone / password reset) and, if Instagram escalates, a ban.

These two pull against each other. The honest framing:

- **Main account** = achieves the actual goal, but you are risking your real account. Mitigate hard
  (2FA, stable device fingerprint, residential/mobile proxy, human pacing, slow warm-up) and accept
  residual risk.
- **Dedicated account** = much safer, but it is a different inbox - only useful if you are willing to
  migrate the people you chat with, or only bridge a subset.

There is no free lunch here. research.md lays out the mitigations either way; the choice is yours.

## Status

- [x] Decision: official vs unofficial -> **unofficial** (official is structurally impossible; see research)
- [x] Decision: library + runtime -> **Python instagrapi sidecar** (see research)
- [ ] Decision: which account (main vs dedicated) - **OPEN, your call** (set it in `.env` at deploy time)
- [x] Build: **IMPLEMENTED.** Node bridge (`src/instagram/`, the `ig` command) + Python sidecar
  (`insta-sidecar/`) + Docker wiring. The Node side is unit-tested green (`npm test`); the Python
  sidecar talks to the real Instagram API and **must be validated against a throwaway account first**
  (Phase 1 in `insta-sidecar/README.md`) before pointing it at any account you care about.

### How it is wired (as built)

- `src/instagram/sidecar-client.js` - Node HTTP client to the sidecar (send / threads / challenge); best-effort, null when unconfigured.
- `src/instagram/bridge.js` - relays inbound DMs into the owner's WhatsApp; the owner-only `ctx.instagram` capability.
- `src/instagram/ingest-server.js` - the loopback endpoint the sidecar pushes inbound events to.
- `src/commands/ig.js` - `jarvis ig` (list) / `jarvis ig <person> <message>` (send) / `jarvis ig code <value>` (challenge).
- `insta-sidecar/` - the Python instagrapi service (poll by default; experimental realtime opt-in).
- Wired in `src/whatsapp-main.js` and `docker-compose.yml` (opt-in: `docker compose --profile instagram up`); config in `.env.example`.

## Caveat on freshness

`instagrapi`'s realtime receive (MQTT) and push (FBNS) are only weeks old as of the research date and
flagged *experimental*; Meta's surface moves fast. Re-verify library state and permission rules at
build time. Full time-sensitivity notes in research.md.
