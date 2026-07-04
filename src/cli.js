import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
import { commands } from './commands/index.js';
import { createStore } from './store/index.js';
import { createScheduler } from './core/scheduler.js';
import { startProactive } from './core/proactive.js';
import { num } from './core/env.js';

// No preset owner (mirrors production): claim it in-session with `jarvis owner claim`,
// or set OWNER_JID. The CLI sender is `cli-user`.
const registry = createRegistry(commands);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const scheduler = createScheduler(store);
// On the CLI, shutdown/restart just end the dev process; logout has no session.
const lifecycle = {
  shutdown: () => setTimeout(() => process.exit(0), 50),
  restart: () => setTimeout(() => process.exit(1), 50),
  wipe: () => setTimeout(() => { store.clearAll(); process.exit(1); }, 50),
};
const adapter = createCliAdapter();
const app = createApp(adapter, {
  handle: createDispatcher(registry, { owner: process.env.OWNER_JID ?? '', store, log, lifecycle, scheduler }),
});

// Proactive output (scheduled messages) runs in the background; on the CLI it prints to stdout.
// Started before the (blocking) start() so the timer is live during the session.
const deliver = (chatId, text) => adapter.send(chatId, text);
const proactiveRunner = startProactive(
  async () => {
    await scheduler.tick(deliver, Date.now());
  },
  { intervalMs: num(process.env.JARVIS_TICK_MS, 30_000), log },
);

await app.start();
await proactiveRunner.stop();
store.close();
