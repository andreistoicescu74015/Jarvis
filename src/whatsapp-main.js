import { createApp } from './core/app.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
import { createStore } from './store/index.js';
import { createScheduler } from './core/scheduler.js';
import { startProactive } from './core/proactive.js';
import { createSqliteAuthState } from './whatsapp/auth-store.js';
import { createWhatsAppAdapter } from './whatsapp/adapter.js';
import { createRateLimiter } from './whatsapp/pacing.js';
import { createIdentityStore } from './whatsapp/identity-store.js';
import { socketLogger } from './whatsapp/socket-logger.js';
import ping from './commands/ping.js';
import help from './commands/help.js';
import man from './commands/man.js';
import whoami from './commands/whoami.js';
import note from './commands/note.js';
import owner from './commands/owner.js';
import whitelist from './commands/whitelist.js';
import blacklist from './commands/blacklist.js';
import groups from './commands/groups.js';
import link from './commands/link.js';
import schedule from './commands/schedule.js';
import shutdown from './commands/shutdown.js';
import restart from './commands/restart.js';
import logout from './commands/logout.js';

/**
 * Composition root for the live WhatsApp bot. Mirrors `cli.js`, but wires the
 * Baileys adapter instead of the CLI one. App data and auth state live in
 * separate sqlite files so credentials stay isolated. Run with `npm start`.
 */
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const registry = createRegistry([ping, help, man, whoami, note, owner, whitelist, blacklist, groups, link, schedule, shutdown, restart, logout]);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const authDb = createStore({ path: process.env.JARVIS_AUTH_DB ?? 'data/wa-auth.db' });
const identity = createIdentityStore(store);
const scheduler = createScheduler(store);
// Read a numeric env var, falling back to `d` for unset/empty/NaN - but honoring an explicit 0
// (so a knob like a 0ms read delay can be turned off, which `Number(x) || d` would clobber).
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

const adapter = createWhatsAppAdapter({
  authState: createSqliteAuthState(authDb, { logger: socketLogger(log) }),
  log,
  prefix: process.env.JARVIS_PREFIX ?? 'jarvis',
  learn: (key) => identity.learnFromKey(key),
  // Single global send limiter (min spacing between any two sends) + human-timing knobs
  // (read-before-reply receipt, length-proportional typing). All optional; conservative defaults.
  rateLimiter: createRateLimiter({ minIntervalMs: num(process.env.JARVIS_SEND_MIN_INTERVAL_MS, 800) }),
  humanize: {
    markOnline: (process.env.JARVIS_MARK_ONLINE ?? 'on') !== 'off',
    profileName: process.env.JARVIS_PROFILE_NAME ?? 'Jarvis',
    readReceipts: (process.env.JARVIS_READ_RECEIPTS ?? 'on') !== 'off',
    readDelayMs: num(process.env.JARVIS_READ_DELAY_MS, 1000),
    typingPerCharMs: num(process.env.JARVIS_TYPING_PER_CHAR_MS, 50),
    typingMaxMs: num(process.env.JARVIS_TYPING_MAX_MS, 6000),
    sendJitterMs: num(process.env.JARVIS_SEND_JITTER_MS, 400),
  },
  // On logout the creds are wiped; exit non-zero so a supervisor restarts us and
  // shows a fresh QR. In dev (no supervisor) it simply stops - rerun `npm start`.
  onLogout: () => quit(1),
});

// Owner lifecycle controls (the shutdown / restart / logout commands). Each defers
// the exit briefly so the confirmation reply is sent first. A process supervisor is
// what brings Jarvis back after a non-zero exit.
const lifecycle = {
  shutdown: () => { log.warn('owner requested shutdown'); setTimeout(() => quit(0), 1500); },
  restart: () => { log.warn('owner requested restart'); setTimeout(() => quit(1), 1500); },
  logout: () => {
    log.warn('owner requested logout');
    setTimeout(async () => { await adapter.logout(); quit(1); }, 1500);
  },
};

const app = createApp(adapter, {
  // match is LID-aware so an owner set by phone number matches a LID sender.
  handle: createDispatcher(registry, {
    owner: process.env.OWNER_JID ?? '',
    // Dormant until an owner exists: silent in groups, private only `owner`, until OWNER_JID is set
    // or someone runs `owner claim`. Disable with JARVIS_REQUIRE_OWNER=off.
    requireOwner: (process.env.JARVIS_REQUIRE_OWNER ?? 'on') !== 'off',
    store,
    log,
    match: identity.same,
    lifecycle,
    listGroups: () => adapter.listGroups(),
    send: (target, message) => adapter.send(target, message),
    scheduler,
    // Canonicalize a named person for the access lists: a JID (e.g. from an @mention)
    // is resolved toward its phone form; a bare number becomes a phone JID. Matching
    // then bridges LID <-> phone, so a person named one way matches a sender on the other.
    resolveUser: (token) => {
      const t = String(token ?? '').trim();
      if (!t) return t;
      if (t.includes('@')) return identity.resolve(t);
      const digits = t.replace(/[^0-9]/g, '');
      return digits ? identity.resolve(`${digits}@s.whatsapp.net`) : t;
    },
  }),
});

// Proactive output (scheduled messages) runs in the background. Delivery reuses the adapter's
// send, which paces every message through the global spacing limiter, so output never bursts.
// Started before the (blocking) start() so the timer is live; the first tick is after one
// interval, so we never deliver before the socket connects.
const deliver = (chatId, text) => adapter.send(chatId, text);
const proactiveRunner = startProactive(
  async () => {
    await scheduler.tick(deliver, Date.now());
  },
  { intervalMs: Number(process.env.JARVIS_TICK_MS), log },
);

let closing = false;
const quit = async (code = 0) => {
  if (closing) return;
  closing = true;
  log.info('Jarvis shutting down...');
  await proactiveRunner.stop();
  await adapter.stop();
  store.close();
  authDb.close();
  process.exit(code);
};
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

log.info('Jarvis starting on WhatsApp - scan the QR on first run to pair.');
await app.start();
