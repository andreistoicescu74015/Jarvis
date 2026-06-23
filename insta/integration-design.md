# Instagram bridge - integration design (forward sketch)

How an Instagram DM bridge would slot into Jarvis. This is a DESIGN, not built. It assumes the
research conclusion: an unofficial private API via a **Python `instagrapi` sidecar**, with Jarvis
(Node 24) as the bridge. See [`research.md`](research.md).

## 1. What we are building (and what we are not)

This is a **personal relay**, owner-only - not a second command bot. Jarvis sits between *your*
Instagram account and *your* WhatsApp:

```
   Instagram DM from @alice
            |
            v
   [instagrapi sidecar]  --realtime push-->  [Jarvis / Node]  --adapter.send-->  your WhatsApp DM
      (Python, MQTT/FBNS)                          |                              "[IG] alice: hey"
            ^                                       |
            |  POST /send                           |  you reply in WhatsApp:
            +------------------ direct_send --------+  "jarvis ig alice hey back"
```

- **Inbound:** an IG DM is pushed to Jarvis, which relays it into your WhatsApp DM-with-Jarvis, tagged
  with the sender.
- **Outbound:** you address Jarvis on WhatsApp (`jarvis ig <person> <text>`); it calls the sidecar,
  which sends the IG DM.
- **Owner-only.** It is your personal account; the feature is gated to the owner exactly like
  `shutdown`/`reset`.

MVP scope: **text DMs only**. Media, reactions, group DMs are explicitly deferred.

## 2. Why this fits Jarvis cleanly

Jarvis already separates the platform from the core (`src/core/app.js`): the core only talks to an
`Adapter` contract (`start({onMessage})` / `send(chatId, msg)` / `stop()`) and a normalized
`InboundMessage` shape - it never imports a platform SDK. Capabilities (community reads, scheduler,
...) are injected into the command context as clean value-objects, never raw SDK shapes. The bridge
reuses all of this:

- A new **capability** `ctx.instagram` (send a DM, list threads), wired in the composition root and
  listed in `capable` - same pattern as `ctx.community` / `ctx.scheduler`.
- A new **owner-only command** `ig` that consumes that capability - same pattern as every command in
  `src/commands/`.
- Inbound relay reuses the existing WhatsApp **`adapter.send`** to deliver into your WhatsApp.
- Anti-ban reuses the existing **pacing** module (`src/whatsapp/pacing.js`): a global send-spacing
  floor + jitter + length-proportional typing. Instagram is *more* ban-sensitive than WhatsApp, so
  this posture is directly relevant.
- Session persistence reuses **`node:sqlite`** via `src/store`, the same as the WhatsApp auth store.

Nothing in `core/` changes. The bridge is additive.

## 3. Components

### 3a. Python sidecar (`insta-sidecar/`, new, Python + instagrapi)

A small long-lived process. Responsibilities:

- **Login + session:** log in once, persist `settings.json` (device fingerprint, cookies, FBNS auth)
  to a mounted volume so restarts reuse the session and do not re-trigger a challenge.
- **Receive:** open the realtime MQTT connection (`direct_subscribe`) and FBNS push; on an inbound DM,
  POST it to Jarvis (`{ thread_id, username, text, ts }`).
- **Send:** expose `POST /send { username|thread_id, text }` -> `client.direct_send(...)`.
- **Proxy:** route HTTP + MQTT through a configured residential/mobile proxy.
- **Challenge:** on `challenge_required`, do NOT loop - surface it (POST a `challenge` event to Jarvis
  so it can ask you, via WhatsApp, to resolve it).

Contract (local only, never exposed): a tiny HTTP/websocket API on `127.0.0.1`. Suggested:
`POST /send`, `GET /threads`, and an outbound webhook/ws to Jarvis for receive + challenge events. A
shared secret in a header; bind to loopback only.

Deployment: a second container in `docker-compose.yml`, on the same Docker network as Jarvis, with its
own small volume for the session file.

### 3b. Node sidecar client (`src/instagram/sidecar-client.js`, new)

Thin Node wrapper around the sidecar's HTTP/ws - the boundary that keeps `instagrapi`'s shapes out of
the core (the "translate, not pass-through" rule):

- `send(thread, text) -> Promise<boolean>` (returns delivery success, like `adapter.send`).
- `onMessage(cb)` / `onChallenge(cb)` for pushed events.
- normalizes a raw IG DM into a clean `{ thread, username, text, ts }` value-object.
- best-effort + isolated: a sidecar outage must never crash Jarvis (same discipline as the AI client,
  which returns null/empty on any failure).

### 3c. Bridge wiring (`src/instagram/bridge.js`, new)

Glue that owns the routing:

- **Inbound:** on a sidecar `message` event, format `"[IG] <username>: <text>"` and
  `adapter.send(ownerJid, ...)` into your WhatsApp. Store a mapping (see 3d) so a reply can be routed.
- **Pacing:** push IG sends through a `createRateLimiter` instance (reuse `src/whatsapp/pacing.js`) so
  IG output never bursts.
- **Challenge:** on a `challenge` event, message you on WhatsApp with what Instagram is asking for.

### 3d. Thread map (`node:sqlite`, reuse `src/store`)

A scoped namespace, e.g. `ig-threads`:

- `username|thread_id <-> friendly handle`, so you can type `jarvis ig alice ...` instead of an id.
- (Phase 2) `whatsapp_quoted_msg_id -> ig_thread_id`, so you can **quote-reply** to a relayed
  "[IG] alice: ..." message in WhatsApp and Jarvis routes it to the right thread automatically.
  Baileys exposes the quoted message's `stanzaId` in `contextInfo` (already parsed in
  `src/whatsapp/normalize.js`), so this is wiring, not new protocol work.

### 3e. The `ig` command (`src/commands/ig.js`, new, owner-only)

```
scope:    { owner: true }          // your personal account; owner-only like shutdown/reset
requires: ['instagram']            // unavailable unless the sidecar is configured
confirm:  false                    // sending a DM is routine (not destructive); the AI may translate it
```

Surface (text MVP):
- `jarvis ig` - list recent IG threads / unread (via `ctx.instagram.threads()`).
- `jarvis ig <person> <text>` - send a DM (via `ctx.instagram.send(person, text)`).
- (Phase 2) plain quote-reply in WhatsApp, no command needed (3d).

Because translation is always-on, "reply to alice that I'll call her" maps to `ig alice ...`
naturally - and the owner-only scope + the existing guards still apply per the golden rule (the model
proposes, core authorizes).

### 3f. Composition root

Wire it where the WhatsApp adapter and AI client are wired (`src/whatsapp-main.js`), and **null when
not configured** - exactly like the AI client. Add a `ctx.instagram` capability built from the sidecar
client, listed in `capable` in `src/core/dispatch.js`. No sidecar URL/token -> capability absent ->
the `ig` command reports "unavailable here" and nothing else changes.

## 4. Config (env, mirrors the existing style)

```
INSTAGRAM_SIDECAR_URL   = http://insta-sidecar:8099   # empty => bridge off (like GITHUB_MODELS_TOKEN)
INSTAGRAM_SIDECAR_TOKEN = <shared secret for the loopback API>
# sidecar-side (Python):
IG_USERNAME / IG_PASSWORD            # the account it drives
IG_PROXY                             # residential/mobile proxy URL
IG_SESSION_FILE = /data/ig-session.json
```

Reuse the WhatsApp pacing knobs (or add `IG_*` mirrors) so IG output is paced independently.

## 5. Build plan (phased)

1. **Spike the sidecar.** Stand up `instagrapi`, log in on a *dedicated* test account behind a proxy,
   confirm `direct_send` works and the realtime receive actually fires for an inbound DM. This
   de-risks the one MEDIUM-confidence, experimental piece before any Jarvis code. -> verify: a DM you
   send from another phone shows up as a pushed event within seconds.
2. **Node client + relay, inbound only.** `sidecar-client.js` + `bridge.js` relaying "[IG] x: ..."
   into your WhatsApp. -> verify: an IG DM appears in your WhatsApp DM-with-Jarvis.
3. **Outbound via the `ig` command.** owner-only send. -> verify: `jarvis ig <you> hi` lands in the IG
   app on the other side.
4. **Thread map + quote-reply UX (Phase 2).** map WhatsApp quoted-msg-id -> IG thread. -> verify:
   quote-replying a relayed message answers the right person.
5. **Harden:** challenge -> WhatsApp prompt; reconnect/backoff on the MQTT connection (mirror
   `src/whatsapp/connection.js`); pacing; session persistence across restarts.

## 6. Risks specific to building this

- The realtime receive is the linchpin and is the least-proven part (experimental, weeks old). Phase 1
  exists precisely to validate it before committing. If it is flaky, fall back to polling
  `direct_threads` on an interval (worse latency, more requests = more ban signal), or reconsider the
  Go `messagix` base.
- A second runtime (Python) in the deployment - a real but modest operational cost.
- Ban risk applies the moment the sidecar logs in. Do Phase 1 on a throwaway account. The main-vs-
  dedicated decision (README) gates whether this ever touches your real account.
- Keep `instagrapi` pinned and watch upstream - the protocol drifts and the library moves fast.
