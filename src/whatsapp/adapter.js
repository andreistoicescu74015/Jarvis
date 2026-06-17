import makeWASocket, { Browsers, jidNormalizedUser } from 'baileys';
import qrcode from 'qrcode-terminal';
import { nullLogger } from '../core/log.js';
import { socketLogger } from './socket-logger.js';
import { toInbound } from './normalize.js';
import { resolveAddressing } from './trigger.js';
import { toContent } from './render.js';
import { createRateLimiter } from './pacing.js';
import { disconnectAction, backoffMs } from './connection.js';

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
 *   learn?: (key: object) => void,
 *   random?: () => number,
 *   now?: () => number,
 *   groupCacheTtlMs?: number,
 *   offlineGraceMs?: number,
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
  learn = () => {},
  random = Math.random,
  now = () => Date.now(),
  groupCacheTtlMs = 5 * 60 * 1000,
  offlineGraceMs = 15 * 1000,
} = {}) {
  const waLog = socketLogger(log);
  /** @type {any} */
  let sock;
  let onMessage = async () => {};
  let stopped = false;
  let attempts = 0;
  let connectedAt = 0; // epoch ms of the latest 'open'; 0 = never connected
  /** @type {Map<string, { meta: any, at: number }>} group metadata cache with TTL. */
  const groupCache = new Map();

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

  function connect() {
    sock = makeSocket({
      auth: authState.state,
      logger: waLog,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: Browsers.ubuntu('Jarvis'),
    });
    sock.ev.on('creds.update', authState.saveCreds);
    sock.ev.on('connection.update', onConnectionUpdate);
    sock.ev.on('messages.upsert', onUpsert);
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates ?? []) if (u?.id) groupCache.delete(u.id);
    });
    sock.ev.on('group-participants.update', (u) => {
      if (u?.id) groupCache.delete(u.id);
    });
  }

  async function onConnectionUpdate({ connection, lastDisconnect, qr } = {}) {
    if (qr) {
      log.info('wa: scan the QR below to pair');
      renderQr(qr);
    }
    if (connection === 'open') {
      attempts = 0;
      connectedAt = now();
      log.info('wa: connected', { user: sock?.user?.id });
      return;
    }
    if (connection !== 'close' || stopped) return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const action = disconnectAction(statusCode);
    log.warn('wa: connection closed', { statusCode, action });

    if (action === 'logout') {
      authState.clear();
      stopped = true;
      log.warn('wa: logged out - creds wiped, not reconnecting');
      onLogout();
    } else if (action === 'restart') {
      connect();
    } else {
      await sleep(backoffMs(attempts++, { rand: random }));
      if (!stopped) connect();
    }
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
        await onMessage({ ...inbound, text, addressed: bare });
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
      if (!sock || stopped) return;
      try {
        await sock.sendPresenceUpdate('composing', chatId);
        await sleep(rateLimiter.nextWaitMs(Math.floor(random() * 400))); // jittered pacing
        await sock.sendMessage(chatId, toContent(message));
        await sock.sendPresenceUpdate('paused', chatId);
      } catch (err) {
        log.error('wa: send failed', { chatId, error: err?.message ?? String(err) });
      }
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
      try {
        sock?.ev?.removeAllListeners?.(); // don't react to teardown events while closing
        sock?.end?.(undefined);
      } catch {
        // already closed - ignore
      }
    },
  };
}
