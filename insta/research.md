# Instagram DM bridge - research findings

**Date:** 2026-06-23. **Method:** multi-angle web fan-out (5 angles, 16 sources fetched, 79 claims
extracted, 25 verified by 3-vote adversarial fact-checking; 23 confirmed, 2 refuted). Confidence
levels and the verifier vote are stated per finding. Primary sources (Meta docs, GitHub/PyPI
metadata) are cited inline and listed at the end.

**Question.** How to programmatically READ and SEND Instagram Direct Messages (text) from a
self-hosted Node.js 24 service, to bridge a personal Instagram account's DMs into Jarvis (WhatsApp) -
the Instagram analogue of how Jarvis drives a personal WhatsApp account via Baileys.

---

## 0. Recommendation (bottom line up front)

- **Route:** UNOFFICIAL private API. The official Meta API is structurally incapable of personal
  peer-to-peer chat (proven below).
- **Library:** Python **`instagrapi`** (`subzeroid/instagrapi`) - the only actively-maintained option
  with first-class read + send + built-in realtime receive.
- **Runtime shape:** a **Python `instagrapi` sidecar** microservice (long-lived MQTT/FBNS receive,
  `direct_send` to send) behind local HTTP/IPC, bridged to the Node 24 Jarvis process. NOT in-process
  Node - the Node libraries for this are stale.
- **Account safety:** use a dedicated account if you can, enable 2FA, keep a consistent device
  fingerprint, route through a residential/mobile proxy, and pace like a human. Ban risk is real.

Confidence: HIGH on route + library (primary-source, unanimous votes). MEDIUM on the sidecar shape
(an inference from the maintenance evidence, not a directly-quoted source).

---

## 1. Official route - Meta's Instagram messaging APIs: UNUSABLE for this

**Finding 1 (HIGH; votes 3-0 on the load-bearing parts).** The official Instagram messaging API
cannot support a personal peer-to-peer use case. It requires an Instagram **professional** account
(Business or Creator) - never an ordinary personal account - and is structurally a
business-to-customer / customer-care model:

- The app **cannot initiate** a DM. Meta docs, verbatim: *"Only after an Instagram user has sent your
  app user's Instagram professional account a message can your app send a message to the Instagram
  user."* There is no loophole - story replies, comment-to-DM, and ice breakers all still require the
  other person to act first.
- Outbound replies are confined to a **24-hour** customer-service window, extendable only to **7 days**
  via the human-agent tag.
- Send + receive is gated behind the `instagram_business_manage_messages` permission, and the
  `messages` webhook only fires when a user messages a professional account.

Sources (primary, Meta):
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
- https://developers.facebook.com/docs/instagram-platform/overview/
- https://developers.facebook.com/docs/instagram-platform/webhooks/

**Finding 2 (HIGH; votes 3-0).** Meta's newer **"Instagram API with Instagram Login"** (launched July
2024) DOES drop the long-standing Facebook Page requirement and authenticates with Instagram
credentials against `graph.instagram.com`. Verbatim: *"This API setup does not require a Facebook Page
to be linked to the Instagram professional account."* This is the most-cited "Instagram finally allows
personal use" claim online - **and it is misleading.** It still requires a professional account, still
cannot initiate, and still imposes the 24-hour window. Dropping the Page requirement changes the
onboarding, not the messaging model.

> **Crux verdict:** the official API is inbound-only customer care. It is unusable for chatting freely
> with friends from your own account the way the app does. This is not a permissions/App-Review
> hurdle you can clear - it is the design. Converting a personal account to professional does not help
> (you still hit professional-only + no-initiation + 24h window).

---

## 2. Unofficial route - private-API libraries (the realistic path)

This is the Instagram analogue of Baileys: a reverse-engineered client that speaks Instagram's
internal app/web protocol (HTTP private endpoints + an MQTT realtime channel), logging in as a normal
account. No webhooks exist here - realtime receive is a long-lived MQTT/FBNS push connection.

**Finding 3 (HIGH; votes 3-0, 2-0).** A private-API path CAN do full bidirectional plain-text DM on a
**personal** account - independently proven by the **`mautrix-meta`** bridge, which drives a real
personal Instagram account via reverse-engineered web/MQTT methods (browser-cookie auth +
the `messagix` MQTT library), not Meta's Graph API. Its roadmap marks text DM done in both directions;
auth is via personal-account cookies (`sessionid`/`csrftoken`/`ds_user_id`/...), no Graph token, no
App Review, no business account. It is the actively-maintained successor (Go, v0.4.0) to the older
Python `mautrix/instagram` bridge, which used an in-tree `mauigpapi` library against the private
Android endpoint `i.instagram.com` + MQTT.
- https://github.com/mautrix/meta
- https://docs.mau.fi/bridges/go/meta/authentication.html
- https://github.com/mautrix/instagram
- https://pkg.go.dev/go.mau.fi/mautrix-meta/pkg/messagix

**Finding 4 (HIGH; votes 3-0 on every axis).** Python **`instagrapi`** (`subzeroid`, formerly
`adw0rd`) is the best-maintained and most complete unofficial library today:
- **Maintenance:** v2.16.24 released 2026-06-20 (3 days before the research date); a burst of releases
  2.16.10 -> 2.16.24 over Jun 18-20 2026; 2,771 commits / 182 releases. Actively alive.
- **DM read + send:** `direct_send(text, user_ids, thread_ids) -> DirectMessage` to send;
  `direct_threads(...)` and `direct_messages(thread_id, amount)` to read.
- **Realtime inbound:** an MQTToT connection opened after login (the `realtime` client, added
  2026-06-01); `direct_subscribe()` -> `iris_subscribe()` handles `MESSAGE_SYNC` and emits a
  `message`/`iris` event for inbound DMs.
- **Push:** a separate **FBNS** channel (`fbns_connect()` / `fbns_on('push')`, added 2026-06-02)
  registers an Android push token for Direct notification callbacks.
- **Proxy / session / challenge:** reuses one `Client.proxy` for HTTP and MQTT; persists session
  settings; documents `challenge_required` resolution (SMS/email).

  Caveat: realtime MQTT (#2560) and FBNS (#2580) are flagged **experimental** and are only weeks old.
- https://github.com/subzeroid/instagrapi
- https://pypi.org/project/instagrapi/
- https://subzeroid.github.io/instagrapi/usage-guide/direct.html
- https://subzeroid.github.io/instagrapi/usage-guide/realtime.html

**Finding 5 (HIGH; votes 3-0).** The Node.js options are materially weaker and effectively stale:
- **`dilame/instagram-private-api`**: last master commit 2024-03-07, last push 2024-08-09, 407 open
  issues, npm 1.46.1. ~2.3 years without a commit. It has **no built-in realtime DM receive** - the
  published package exposes only repositories/feeds/services; realtime is reserved for an unreleased
  paid 3.x. The popular framing of this as "the canonical Node analogue of Baileys" **did not survive
  verification (vote 1-2)** - do not treat Node as a co-equal route.
- **`Nerixyz/instagram_mqtt`** (the realtime/FBNS companion to dilame): provides exactly the MQTT +
  FBNS receive a bridge needs (Direct messaging, typing, presence, live events; FBNS push), BUT its
  README states verbatim *"This library isn't actively maintained anymore. Only bug fixes are
  accepted."* Last release v1.2.3 / activity April 2024.
- https://github.com/dilame/instagram-private-api
- https://github.com/Nerixyz/instagram_mqtt
- https://www.npmjs.com/package/instagram-private-api
- https://www.npmjs.com/package/instagram_mqtt

### Library comparison

| | `instagrapi` (Python) | `dilame` + `instagram_mqtt` (Node) | `messagix` (Go, in mautrix-meta) |
|---|---|---|---|
| Maintained 2026 | **Yes** (v2.16.24, Jun 2026) | No (2024-03 / 2024-04) | **Yes** (v0.4.0) |
| DM read + send | Yes | Yes (send via dilame) | Yes (bidirectional text) |
| Realtime receive (MQTT/FBNS) | **Built-in** (experimental, new) | Yes, but via the unmaintained companion | Yes (core of the bridge) |
| Personal account, no business | Yes | Yes | Yes (cookie auth) |
| Fit for a Node 24 service | Sidecar (different language) | In-process, but stale deps | Separate Go process / fork |
| Risk | Experimental realtime; ToS ban | Stale; you maintain the protocol drift | Go mismatch; heaviest to embed |

---

## 3. Node.js vs Python for a Node 24 service

**Finding 6 (MEDIUM; inference from the 3-0 maintenance findings, not a single quoted claim).** Prefer
a **Python `instagrapi` sidecar** microservice over in-process Node. Reasoning:

- The critical capability is realtime inbound DM, because the private API has **no webhooks**. The only
  actively-maintained library with first-class, built-in realtime receive is `instagrapi`.
- The in-process Node path means gluing two stale dependencies (`dilame` @ 2024-03 + `instagram_mqtt`
  @ 2024-04) for the exact realtime path that has to stay alive against Instagram's changing protocol.
  That is the most fragile possible choice for the most fragile part of the system.
- The operational cost of a sidecar is modest: a small Python process exposing a local send endpoint
  and pushing receive events to Jarvis, and you inherit upstream fixes.

Alternative worth noting: **`mautrix-meta`** (Go) is the most battle-tested personal-account IG DM
implementation in existence. Embedding/forking its `messagix` library, or running mautrix-meta headless
and bridging to it, is the most *durable* base - but it is Go, the heaviest to integrate, and overkill
for a text-only personal relay. Keep it as a fallback if `instagrapi`'s young realtime proves unstable.

---

## 4. Account safety / ban risk

**Finding 7 (HIGH; votes 2-0 + corroboration).** The risk is real and tightening in 2025-2026.
Instagram may decide an account has suspicious activity and block it behind a `challenge_required`
(captcha, add a phone number, or password reset). mautrix docs, verbatim: *"In some cases, Meta may
decide your account has suspicious activity and block you until you do some tasks like completing a
captcha, adding a phone number or resetting your password"* and *"It is recommended to have two-factor
authentication enabled to reduce the risk of such blocks."*

Concrete mitigations (supported across sources):
- **Dedicated account** over your main, to keep the main out of harm's way (tradeoff: it is a different
  inbox - see README).
- **2FA enabled** (the maintainers assert this reduces automation blocks; note this is their rationale,
  not independently proven).
- **Consistent device/session fingerprint** - persist and reuse the generated device, do not
  regenerate per login.
- **Residential/mobile proxy** matched to the account's usual geography (`instagrapi` reuses one proxy
  for HTTP and MQTT).
- **Human-like pacing and rate limits** - the same posture Jarvis already uses on WhatsApp (a global
  send spacing floor, jitter, length-proportional "typing").
- **Warm-up** a fresh account slowly before driving it via automation.
- **Handle `challenge_required`** gracefully and surface it to you (e.g. relay the prompt into
  WhatsApp) rather than hammering on failure.

- https://docs.mau.fi/bridges/go/meta/authentication.html
- https://subzeroid.github.io/instagrapi/usage-guide/challenge_resolve.html

---

## 5. ToS / legal reality

Automating a personal account violates Instagram's Platform Terms. In practice, enforcement is at the
**account level** (challenges, then suspension/ban), **not lawsuits** against individuals running a
personal bot. The realistic worst case is losing the account, not legal action - which is exactly why
the account choice (main vs dedicated) is the decision that matters.

---

## 6. Caveats & time-sensitivity (HIGH)

- **Fast-moving surface.** `instagrapi` shipped ~14 releases in 3 days (Jun 18-20 2026); its realtime
  MQTT (#2560) + FBNS (#2580) are *experimental* and only weeks old. Realtime stability over a
  long-lived 24/7 connection is unproven - load-test before relying on it.
- **Meta docs change.** They reference API v25.0 / Jan-2025 scope deprecations, with more noted into
  2026. Re-verify permission names and window rules at integration time.
- **Echo risk.** Some verifier searches mirrored claim wording; where flagged, verifiers fell back to
  raw source-code / primary metadata, which corroborated independently.
- **Scope.** This report covers TEXT DMs only. Media, reactions, group-DM behavior, and exact
  private-API rate limits were not separately verified.
- **Refuted claims** (did not survive verification): (a) "dilame is the canonical Node analogue of
  Baileys" (vote 1-2 - it is the weaker, stale option); (b) "mautrix/instagram is deprecated/archived"
  (vote 1-0, could not be confirmed - treat as unverified, though mautrix-meta is clearly the current
  one).

---

## 7. Open questions to resolve at build time

1. How stable is `instagrapi`'s brand-new realtime MQTT + FBNS receive under a long-lived 24/7 bridge -
   reconnection, missed-message backfill via Iris cursors, memory over days/weeks?
2. What are the current private-API DM send/receive rate limits and warm-up thresholds on a dedicated
   account, and how fast does Instagram escalate from `challenge_required` to a permanent ban?
3. The best Node <-> Python sidecar contract (local HTTP/websocket vs a queue), how to persist session
   state (settings, FBNS auth, device fingerprint) across restarts, and how to surface a 2FA/challenge
   prompt back to you via WhatsApp.
4. Is forking/embedding mautrix-meta's `messagix` (Go) a more durable base than `instagrapi`, despite
   the language mismatch, if the young Python realtime proves flaky?

---

## Sources

Primary (load-bearing):
- Meta Instagram Platform docs: messaging-api, overview, instagram-api-with-instagram-login, webhooks
  (developers.facebook.com/docs/instagram-platform/...)
- github.com/subzeroid/instagrapi ; pypi.org/project/instagrapi ; subzeroid.github.io/instagrapi (direct, realtime, challenge_resolve)
- github.com/dilame/instagram-private-api ; github.com/Nerixyz/instagram_mqtt (+ npm pages)
- github.com/mautrix/meta ; docs.mau.fi/bridges/go/meta/authentication.html ; github.com/mautrix/instagram ; pkg.go.dev/go.mau.fi/mautrix-meta/pkg/messagix

Secondary (corroborating, 2026): proxies.sx, multilogin, creatorflow.so, contentstudio.io,
instagrapi discussions #2224, getphyllo, elfsight, zernio, keyapi.ai.
