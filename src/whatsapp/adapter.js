import makeWASocket, { Browsers, jidNormalizedUser, isJidGroup } from 'baileys';
import qrcode from 'qrcode-terminal';
import { nullLogger } from '../core/log.js';
import { communityIdOf } from './identity.js';
import { socketLogger } from './socket-logger.js';
import { toInbound } from './normalize.js';
import { resolveAddressing } from './trigger.js';
import { toContent } from './render.js';
import { createRateLimiter, typingDelayMs } from './pacing.js';
import { disconnectAction, stopReason, backoffMs } from './connection.js';
import { toCommunity } from './community.js';

/** Read a WAMessage timestamp (seconds, number or Long) as epoch ms, or 0 if absent. */
function timestampMs(wa) {
  const t = wa?.messageTimestamp;
  if (t == null) return 0;
  const n = typeof t === 'number' ? t : typeof t?.toNumber === 'function' ? t.toNumber() : Number(t);
  return Number.isFinite(n) ? n * 1000 : 0;
}

/**
 * WhatsApp adapter (Baileys v7-rc). Realizes the platform Adapter contract over a
 * live socket: normalize inbound, enforce the prefix-or-@mention trigger, pace
 * outbound. The socket is recreated on every reconnect and never held outside
 * this module (commands must not cache it). Auth state persists via the injected
 * `authState`.
 *
 * Hardening: the offline backlog delivered on reconnect is skipped (we only act
 * on messages at/after the connection), group metadata is cached with a TTL and
 * invalidated on group/participant updates, and a logout wipes creds and signals
 * a clean exit. `makeSocket` / `sleep` / `renderQr` / `now` are injectable for tests.
 *
 * @param {{
 *   authState: { state: object, saveCreds: () => void, clear: () => void },
 *   log?: import('../core/log.js').Logger,
 *   prefix?: string,
 *   rateLimiter?: ReturnType<typeof createRateLimiter>,
 *   makeSocket?: typeof makeWASocket,
 *   sleep?: (ms: number) => Promise<void>,
 *   renderQr?: (qr: string) => void,
 *   onLogout?: () => void,
 *   onFatal?: (reason: string) => void,
 *   onRemoved?: (chatId: string) => void,
 *   onConnectionState?: (connected: boolean) => void,
 *   learn?: (key: object) => void,
 *   random?: () => number,
 *   now?: () => number,
 *   maxReconnects?: number,
 *   groupCacheTtlMs?: number,
 *   offlineGraceMs?: number,
 *   humanize?: { markOnline?: boolean, profileName?: string, readReceipts?: boolean, readDelayMs?: number, typingPerCharMs?: number, typingMaxMs?: number, sendJitterMs?: number },
 * }} opts
 * @returns {import('../core/app.js').Adapter}
 */
export function createWhatsAppAdapter({
  authState,
  log = nullLogger,
  prefix = 'jarvis',
  rateLimiter = createRateLimiter(),
  makeSocket = makeWASocket,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  renderQr = (qr) => qrcode.generate(qr, { small: true }),
  onLogout = () => {},
  onFatal = () => {},
  onRemoved = () => {},
  onConnectionState = () => {},
  learn = () => {},
  random = Math.random,
  now = () => Date.now(),
  maxReconnects = 10,
  groupCacheTtlMs = 5 * 60 * 1000,
  offlineGraceMs = 15 * 1000,
  humanize = {},
} = {}) {
  // Human-presence heuristics (anti-ban). All optional, conservative defaults; tuned via env at
  // the composition root. `markOnline` presents as online on connect - REQUIRED for WhatsApp to
  // register delivery (two ticks) and read receipts: an offline ("unavailable") client acks
  // incoming messages as "inactive", so they stay on one tick and "seen" never shows. WhatsApp
  // only broadcasts that presence if the account HAS A PROFILE NAME, so `profileName` sets one
  // when the account has none (empty string = never touch the name). `sendJitterMs` randomizes
  // each send; `typing*` shape the "typing..." duration; `read*` govern the read-before-reply receipt.
  const {
    markOnline = true,
    profileName = 'Jarvis',
    readReceipts = true,
    readDelayMs = 1000,
    typingPerCharMs = 50,
    typingMaxMs = 6000,
    sendJitterMs = 400,
  } = humanize;
  const waLog = socketLogger(log);
  /** @type {any} */
  let sock;
  let onMessage = async () => {};
  let stopped = false;
  let attempts = 0;
  let connectedAt = 0; // epoch ms of the latest 'open'; 0 = never connected
  /** @type {Map<string, { meta: any, at: number }>} group metadata cache with TTL. */
  const groupCache = new Map();
  /** @type {Map<string, { value: any, at: number }>} community read cache with TTL. */
  const communityCache = new Map();

  async function groupMetadata(jid) {
    const cached = groupCache.get(jid);
    if (cached && now() - cached.at < groupCacheTtlMs) return cached.meta;
    try {
      const meta = await sock.groupMetadata(jid);
      groupCache.set(jid, { meta, at: now() });
      return meta;
    } catch {
      return cached?.meta; // fall back to stale on a fetch error, else undefined
    }
  }

  // Read a community's shape (name, description, linked sub-groups + member counts) by its
  // announcement-group jid. Two reads (metadata + linked groups) folded into one cached value,
  // mirroring groupMetadata: cheap on repeat, best-effort (falls back to stale, then undefined,
  // on a fetch error - a read must never throw into a command). Read-only; no community is mutated.
  async function communityInfo(jid) {
    if (!jid || !sock || stopped) return undefined;
    const cached = communityCache.get(jid);
    if (cached && now() - cached.at < groupCacheTtlMs) return cached.value;
    try {
      const [meta, linked] = await Promise.all([sock.communityMetadata(jid), sock.communityFetchLinkedGroups(jid)]);
      const value = toCommunity(meta, linked);
      communityCache.set(jid, { value, at: now() });
      return value;
    } catch (err) {
      log.debug('wa: community fetch failed', { jid, error: err?.message ?? String(err) });
      return cached?.value;
    }
  }

  // Read-before-reply (humanization): mark a message we are about to act on as read, after a
  // short jittered reaction delay, so the sender sees a "seen" before the reply lands - like a
  // person. Best-effort: a receipt failure never blocks handling. Skipped when readReceipts is
  // off. Note: this marks read any ADDRESSED message, even from a blacklisted sender (the access
  // check is the core's, downstream); the owner-list "silence" is about not replying, and a blue
  // tick is what a human client shows anyway.
  async function markRead(key) {
    const s = sock; // capture: a reconnect during the delay must not act on a new/torn-down socket
    if (!readReceipts || !key || !s || stopped) return;
    try {
      if (readDelayMs > 0) await sleep(readDelayMs + Math.floor(random() * readDelayMs));
      if (stopped || sock !== s) return;
      await s.readMessages?.([key]);
    } catch (err) {
      log.debug('wa: read receipt failed', { error: err?.message ?? String(err) });
    }
  }

  // Go online so WhatsApp activates receipts. Crucial detail: WhatsApp ignores an online presence
  // from an account with no profile name (Baileys logs "no name present, ignoring presence update"),
  // which silently leaves every incoming message on one tick. So if the account is unnamed, give it
  // `profileName` first, then broadcast 'available' (which flips delivery + read receipts to active).
  // Best-effort and runs on every (re)connect; skipped entirely when markOnline is off.
  async function ensurePresence() {
    const s = sock; // capture: don't touch a socket swapped out by a reconnect mid-await
    if (!markOnline || !s || stopped) return;
    // Name an unnamed account - best-effort and ISOLATED in its own try, so a failure (e.g. the
    // app-state keys are not synced yet right after pairing - "App state key not present!") can
    // NEVER skip the presence broadcast below. WhatsApp ignores an online presence from a nameless
    // account, so a name still matters: if the bot cannot set it here, set one on the account
    // directly (its WhatsApp profile) and receipts will activate.
    if (!s.user?.name && profileName) {
      try {
        await s.updateProfileName(profileName);
        log.info('wa: set profile name (account had none)', { name: profileName });
      } catch (err) {
        const error = err?.message ?? String(err);
        // "App state key not present" is the expected fresh-pairing case (app-state not synced yet); it
        // self-resolves or is handled by naming the account, so keep it at debug. Surface real failures.
        log[/app state key/i.test(error) ? 'debug' : 'warn'](
          'wa: could not set the profile name - set one on the account if receipts stay one-tick',
          { error },
        );
      }
    }
    if (stopped || sock !== s) return;
    try {
      await s.sendPresenceUpdate('available'); // go online so delivery + read receipts activate
    } catch (err) {
      log.debug('wa: presence update failed', { error: err?.message ?? String(err) });
    }
  }

  // Whether the bot itself is among a set of participant jids (LID- or PN-aware).
  function isSelfParticipant(participants) {
    const selfIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
    return (participants ?? []).some((p) => {
      const pn = jidNormalizedUser(p);
      return selfIds.some((s) => s === pn);
    });
  }

  function connect() {
    const s = makeSocket({
      auth: authState.state,
      logger: waLog,
      markOnlineOnConnect: markOnline,
      syncFullHistory: false,
      browser: Browsers.ubuntu('Jarvis'),
    });
    sock = s;
    s.ev.on('creds.update', authState.saveCreds);
    // Bind each socket's connection events to that socket, so a late close from a socket a reconnect
    // already replaced is ignored (it would otherwise spawn a second, racing socket).
    s.ev.on('connection.update', (u) => onConnectionUpdate(u, s));
    s.ev.on('messages.upsert', onUpsert);
    s.ev.on('groups.update', (updates) => {
      for (const u of updates ?? []) if (u?.id) groupCache.delete(u.id);
    });
    s.ev.on('group-participants.update', (u) => {
      if (!u?.id) return;
      groupCache.delete(u.id);
      // If the bot itself was removed from the group, tell the core - a group the bot is no longer in
      // must go silent, including its scheduled proactive sends (which otherwise keep firing into it).
      if (u.action === 'remove' && isSelfParticipant(u.participants)) {
        log.warn('wa: removed from a group - signalling deactivation', { id: u.id });
        onRemoved(u.id);
      }
    });
  }

  async function onConnectionUpdate({ connection, lastDisconnect, qr } = {}, eventSock) {
    if (eventSock && eventSock !== sock) return; // a stale event from a socket a reconnect replaced
    if (qr) {
      log.info('wa: scan the QR below to pair');
      renderQr(qr);
    }
    if (connection === 'open') {
      attempts = 0;
      connectedAt = now();
      onConnectionState(true); // liveness: we are connected (the heartbeat tracks this)
      log.info('wa: connected', { user: sock?.user?.id });
      await ensurePresence(); // name the account if needed, then go online so receipts register
      return;
    }
    if (connection !== 'close' || stopped) return;
    onConnectionState(false); // disconnected (until the next 'open'); a long gap makes the bot unhealthy

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const action = disconnectAction(statusCode);
    // Routine churn (the post-pairing 515 restart, idle 428 reconnects) is expected - keep it at debug so
    // the operator log stays signal; a persistent flap still surfaces via the reconnect-exhaustion error.
    if (action === 'restart' || action === 'reconnect') log.debug('wa: connection closed', { statusCode, action, attempts });

    if (action === 'logout') {
      authState.clear();
      stopped = true;
      // A logout BEFORE we ever connected is WhatsApp rejecting the just-paired session (a known
      // companion-pairing flakiness), not a real unlink. Both wipe creds and re-pair; say which happened.
      if (connectedAt) {
        log.warn('wa: logged out - device unlinked; creds wiped, a fresh QR will be shown to re-pair');
      } else {
        log.warn('wa: pairing rejected by WhatsApp (device removed before connecting) - creds wiped; re-scan the fresh QR. If it keeps happening, remove old linked devices on your phone, then pair once.');
      }
      onLogout();
      return;
    }
    if (action === 'stop') {
      // Terminal: another session took over (440), the account is blocked (403), or the session is
      // unrecoverable (500). Reconnecting would fight the takeover or hammer a banned account, so we
      // stay down and let the operator step in (the composition root keeps the process down).
      stopped = true;
      const reason = stopReason(statusCode);
      log.error('wa: fatal disconnect - not reconnecting', { statusCode, reason });
      onFatal(reason);
      return;
    }
    // 'restart' (515) and 'reconnect' both recreate the socket. Cap consecutive attempts so a flap
    // cannot hot-loop forever; on exhaustion hand off to the supervisor for a clean restart. The
    // counter resets on the next 'open'.
    if (attempts >= maxReconnects) {
      stopped = true;
      log.error('wa: too many reconnect attempts - giving up', { attempts });
      onFatal('exhausted');
      return;
    }
    const delay = backoffMs(attempts, { rand: random });
    attempts += 1;
    await sleep(delay);
    if (!stopped) connect();
  }

  async function onUpsert({ type, messages } = {}) {
    if (type !== 'notify') return;
    // The bot is addressable by both its phone-number JID and its LID; in v7 groups a
    // mention of the bot usually arrives as the LID, so match against both forms.
    const selfIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
    for (const wa of messages ?? []) {
      try {
        if (wa?.key?.fromMe) continue;
        // Skip the offline backlog redelivered on (re)connect: messages sent before
        // we came online. Messages without a timestamp can't be aged, so they pass.
        const ts = timestampMs(wa);
        if (connectedAt && ts && ts < connectedAt - offlineGraceMs) continue;

        learn(wa.key); // lazily record LID <-> phone pairs from the key

        const isGroup = String(wa?.key?.remoteJid || '').endsWith('@g.us');
        const inbound = toInbound(wa, { groupMetadata: isGroup ? await groupMetadata(wa.key.remoteJid) : undefined });
        if (!inbound) continue;
        const { handle, bare, text } = resolveAddressing(inbound, { selfId: selfIds, prefix });
        if (!handle) continue;
        await markRead(wa.key); // read-before-reply: a person reads what they answer
        await onMessage({ ...inbound, text, addressed: bare, self: selfIds });
      } catch (err) {
        log.error('wa: failed to handle an inbound message', { error: err?.message ?? String(err) });
      }
    }
  }

  return {
    start(handlers) {
      onMessage = handlers?.onMessage ?? onMessage;
      stopped = false;
      connect();
    },

    async send(chatId, message) {
      const s = sock; // capture: the pacing wait can span a reconnect; don't send on a new/dead socket
      if (!s || stopped) return;
      try {
        const content = toContent(message);
        // Look like a person composing: show "typing..." then send. The wait is the global
        // spacing floor (so sends never burst, even across chats) PLUS a "typing time" roughly
        // proportional to the reply length (capped) and a little jitter. Folding the typing time
        // into the limiter means the next send is spaced from this one's real send time.
        const typing = typingDelayMs((content?.text ?? '').length, { perCharMs: typingPerCharMs, maxMs: typingMaxMs });
        await s.sendPresenceUpdate('composing', chatId);
        await sleep(rateLimiter.nextWaitMs(typing + Math.floor(random() * sendJitterMs)));
        if (stopped || sock !== s) return; // a reconnect/teardown happened during the pacing wait
        await s.sendMessage(chatId, content);
        await s.sendPresenceUpdate('paused', chatId);
      } catch (err) {
        log.error('wa: send failed', { chatId, error: err?.message ?? String(err) });
      }
    },

    async listGroups() {
      if (!sock || stopped) return [];
      try {
        const all = await sock.groupFetchAllParticipating();
        return Object.values(all || {}).map((g) => {
          const size = Number.isFinite(g.size) ? g.size : Array.isArray(g.participants) ? g.participants.length : undefined;
          return {
            id: g.id,
            name: g.subject || g.id,
            // Community wiring: a sub-group carries `linkedParent` (its community's announcement group);
            // the announcement group itself is flagged `isCommunity`. Either lets the list group them.
            community: g.linkedParent || (g.isCommunity ? g.id : undefined),
            isCommunity: !!g.isCommunity,
            ...(size !== undefined ? { size } : {}), // member count, when WhatsApp reports it
          };
        });
      } catch (err) {
        log.error('wa: failed to list groups', { error: err?.message ?? String(err) });
        return [];
      }
    },

    // Community reads (platform capability; read-only). `info` returns a shaped Community
    // (name, description, linked sub-groups + member counts, reach) by announcement-group jid,
    // cached; `groups` is just its sub-groups; `all` shallow-lists the communities the bot is in
    // (no sub-groups, to avoid a fetch per community). Off a community this is simply absent.
    community: {
      info: (id) => communityInfo(id),
      groups: async (id) => (await communityInfo(id))?.subGroups ?? [],
      all: async () => {
        if (!sock || stopped) return [];
        try {
          const all = await sock.communityFetchAllParticipating();
          return Object.values(all || {}).map((c) => ({
            id: c.id,
            name: c.subject || c.id,
            reach: Number.isFinite(c.size) ? c.size : Array.isArray(c.participants) ? c.participants.length : 0,
          }));
        } catch (err) {
          log.error('wa: failed to list communities', { error: err?.message ?? String(err) });
          return [];
        }
      },
    },

    // Resolve a chat's parent community jid (announcement group = itself, a sub-group = its parent),
    // from cached group metadata - for the activation umbrella on the proactive path, which has only a
    // chatId. Undefined for a non-group, a plain group, or a metadata miss.
    async communityOf(chatId) {
      if (!chatId || !isJidGroup(chatId) || !sock || stopped) return undefined;
      return communityIdOf(chatId, await groupMetadata(chatId));
    },

    async logout() {
      stopped = true;
      try {
        await sock?.logout?.(); // ask WhatsApp to unlink this device (best-effort)
      } catch {
        // ignore - we wipe local creds regardless
      }
      try {
        authState.clear();
      } catch {
        // ignore
      }
    },

    async stop() {
      stopped = true;
      onConnectionState(false); // no longer connected (teardown)
      try {
        sock?.ev?.removeAllListeners?.(); // don't react to teardown events while closing
        sock?.end?.(undefined);
      } catch {
        // already closed - ignore
      }
    },
  };
}
