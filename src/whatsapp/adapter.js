import makeWASocket, { Browsers, jidNormalizedUser } from 'baileys';
import qrcode from 'qrcode-terminal';
import { nullLogger } from '../core/log.js';
import { socketLogger } from './socket-logger.js';
import { toInbound } from './normalize.js';
import { resolveAddressing } from './trigger.js';
import { toContent } from './render.js';
import { createRateLimiter } from './pacing.js';
import { disconnectAction, backoffMs } from './connection.js';

/**
 * WhatsApp adapter (Baileys v7-rc). Realizes the platform Adapter contract over a
 * live socket: normalize inbound, enforce the prefix-or-@mention trigger, pace
 * outbound. The socket is recreated on every reconnect and never held outside
 * this module (commands must not cache it). Auth state persists via the injected
 * `authState`. `makeSocket` / `sleep` / `renderQr` are injectable for testing.
 *
 * @param {{
 *   authState: { state: object, saveCreds: () => void, clear: () => void },
 *   log?: import('../core/log.js').Logger,
 *   prefix?: string,
 *   rateLimiter?: ReturnType<typeof createRateLimiter>,
 *   makeSocket?: typeof makeWASocket,
 *   sleep?: (ms: number) => Promise<void>,
 *   renderQr?: (qr: string) => void,
 *   random?: () => number,
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
  random = Math.random,
} = {}) {
  const waLog = socketLogger(log);
  /** @type {any} */
  let sock;
  let onMessage = async () => {};
  let stopped = false;
  let attempts = 0;
  /** @type {Map<string, any>} group metadata cache (community + admin resolution). */
  const groupCache = new Map();

  async function groupMetadata(jid) {
    if (groupCache.has(jid)) return groupCache.get(jid);
    try {
      const meta = await sock.groupMetadata(jid);
      groupCache.set(jid, meta);
      return meta;
    } catch {
      return undefined; // first contact / not yet available - degrade gracefully
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
  }

  async function onConnectionUpdate({ connection, lastDisconnect, qr } = {}) {
    if (qr) {
      log.info('wa: scan the QR below to pair');
      renderQr(qr);
    }
    if (connection === 'open') {
      attempts = 0;
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
    } else if (action === 'restart') {
      connect();
    } else {
      await sleep(backoffMs(attempts++, { rand: random }));
      if (!stopped) connect();
    }
  }

  async function onUpsert({ type, messages } = {}) {
    if (type !== 'notify') return;
    const selfId = jidNormalizedUser(sock?.user?.id || '');
    for (const wa of messages ?? []) {
      try {
        if (wa?.key?.fromMe) continue;
        const isGroup = String(wa?.key?.remoteJid || '').endsWith('@g.us');
        const inbound = toInbound(wa, { groupMetadata: isGroup ? await groupMetadata(wa.key.remoteJid) : undefined });
        if (!inbound) continue;
        const { handle, bare, text } = resolveAddressing(inbound, { selfId, prefix });
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

    async stop() {
      stopped = true;
      try {
        sock?.end?.(undefined);
      } catch {
        // already closed - ignore
      }
    },
  };
}
