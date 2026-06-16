import { createApp } from './core/app.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
import { createStore } from './store/index.js';
import { createSqliteAuthState } from './whatsapp/auth-store.js';
import { createWhatsAppAdapter } from './whatsapp/adapter.js';
import { socketLogger } from './whatsapp/socket-logger.js';
import ping from './commands/ping.js';
import help from './commands/help.js';
import whoami from './commands/whoami.js';
import note from './commands/note.js';

/**
 * Composition root for the live WhatsApp bot. Mirrors `cli.js`, but wires the
 * Baileys adapter instead of the CLI one. App data and auth state live in
 * separate sqlite files so credentials stay isolated. Run with `npm start`.
 */
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const registry = createRegistry([ping, help, whoami, note]);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const authDb = createStore({ path: process.env.JARVIS_AUTH_DB ?? 'data/wa-auth.db' });

const adapter = createWhatsAppAdapter({
  authState: createSqliteAuthState(authDb, { logger: socketLogger(log) }),
  log,
  prefix: process.env.JARVIS_PREFIX ?? 'jarvis',
  // On logout the creds are wiped; exit non-zero so a supervisor restarts us and
  // shows a fresh QR. In dev (no supervisor) it simply stops - rerun `npm start`.
  onLogout: () => shutdown(1),
});
const app = createApp(adapter, {
  handle: createDispatcher(registry, { owner: process.env.OWNER_JID ?? '', store, log }),
});

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  log.info('Jarvis shutting down...');
  await adapter.stop();
  store.close();
  authDb.close();
  process.exit(code);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info('Jarvis starting on WhatsApp - scan the QR on first run to pair.');
await app.start();
