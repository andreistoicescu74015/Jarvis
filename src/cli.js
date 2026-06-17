import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
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
import broadcast from './commands/broadcast.js';
import schedule from './commands/schedule.js';
import shutdown from './commands/shutdown.js';
import restart from './commands/restart.js';
import logout from './commands/logout.js';
import { createStore } from './store/index.js';
import { createScheduler } from './core/scheduler.js';
import { createSendBudget } from './core/send-budget.js';
import { createOutbox } from './core/outbox.js';
import { startProactive } from './core/proactive.js';

// No preset owner (mirrors production): claim it in-session with `jarvis owner claim`,
// or set OWNER_JID. The CLI sender is `cli-user`.
const registry = createRegistry([ping, help, man, whoami, note, owner, whitelist, blacklist, groups, link, broadcast, schedule, shutdown, restart, logout]);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const scheduler = createScheduler(store);
const budget = createSendBudget(store, {
  perCommand: { perHour: Number(process.env.JARVIS_SEND_PER_HOUR) || 60, perDay: Number(process.env.JARVIS_SEND_PER_DAY) || 300 },
  global: { perHour: Number(process.env.JARVIS_SEND_GLOBAL_PER_HOUR) || 120, perDay: Number(process.env.JARVIS_SEND_GLOBAL_PER_DAY) || 600 },
});
const outbox = createOutbox(store);
// On the CLI, shutdown/restart just end the dev process; logout has no session.
const lifecycle = {
  shutdown: () => setTimeout(() => process.exit(0), 50),
  restart: () => setTimeout(() => process.exit(1), 50),
};
const adapter = createCliAdapter();
const app = createApp(adapter, {
  handle: createDispatcher(registry, { owner: process.env.OWNER_JID ?? '', store, log, lifecycle, scheduler, outbox }),
});

// Proactive output (scheduled messages + queued broadcasts) runs in the background, paced
// by the send budget; on the CLI it prints to stdout. Scheduled messages drain before the
// broadcast queue, so a due reminder gets the shared budget slot ahead of a bulk broadcast.
// Started before the (blocking) start() so the timer is live during the session.
const deliver = (chatId, text) => adapter.send(chatId, text);
const proactiveRunner = startProactive(
  async () => {
    const at = Date.now();
    await scheduler.tick(deliver, at, budget);
    await outbox.drain({ deliver, budget, at });
  },
  { intervalMs: Number(process.env.JARVIS_TICK_MS), log },
);

await app.start();
await proactiveRunner.stop();
store.close();
