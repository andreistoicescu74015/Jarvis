import { createApp } from './core/app.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
import { createStore } from './store/index.js';
import { createSqliteAuthState } from './whatsapp/auth-store.js';
import { createWhatsAppAdapter } from './whatsapp/adapter.js';
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
import shutdown from './commands/shutdown.js';
import restart from './commands/restart.js';
import logout from './commands/logout.js';

/**
 * Composition root for the live WhatsApp bot. Mirrors `cli.js`, but wires the
 * Baileys adapter instead of the CLI one. App data and auth state live in
 * separate sqlite files so credentials stay isolated. Run with `npm start`.
 */
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const registry = createRegistry([ping, help, man, whoami, note, owner, whitelist, blacklist, shutdown, restart, logout]);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const authDb = createStore({ path: process.env.JARVIS_AUTH_DB ?? 'data/wa-auth.db' });
const identity = createIdentityStore(store);

const adapter = createWhatsAppAdapter({
  authState: createSqliteAuthState(authDb, { logger: socketLogger(log) }),
  log,
  prefix: process.env.JARVIS_PREFIX ?? 'jarvis',
  learn: (key) => identity.learnFromKey(key),
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
    store,
    log,
    match: identity.same,
    lifecycle,
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

let closing = false;
const quit = async (code = 0) => {
  if (closing) return;
  closing = true;
  log.info('Jarvis shutting down...');
  await adapter.stop();
  store.close();
  authDb.close();
  process.exit(code);
};
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

log.info('Jarvis starting on WhatsApp - scan the QR on first run to pair.');
await app.start();
