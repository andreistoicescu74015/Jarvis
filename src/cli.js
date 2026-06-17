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
import shutdown from './commands/shutdown.js';
import restart from './commands/restart.js';
import logout from './commands/logout.js';
import { createStore } from './store/index.js';

// No preset owner (mirrors production): claim it in-session with `jarvis owner claim`,
// or set OWNER_JID. The CLI sender is `cli-user`.
const registry = createRegistry([ping, help, man, whoami, note, owner, whitelist, blacklist, groups, shutdown, restart, logout]);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
// On the CLI, shutdown/restart just end the dev process; logout has no session.
const lifecycle = {
  shutdown: () => setTimeout(() => process.exit(0), 50),
  restart: () => setTimeout(() => process.exit(1), 50),
};
const app = createApp(createCliAdapter(), {
  handle: createDispatcher(registry, { owner: process.env.OWNER_JID ?? '', store, log, lifecycle }),
});

await app.start();
store.close();
