import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import ping from './commands/ping.js';
import help from './commands/help.js';
import whoami from './commands/whoami.js';
import note from './commands/note.js';
import { createStore } from './store/index.js';

// In CLI dev you are the owner (owner-only commands work).
const registry = createRegistry([ping, help, whoami, note]);
const store = createStore({ path: 'data/jarvis.db' });
const app = createApp(createCliAdapter(), {
  handle: createDispatcher(registry, { owner: 'cli-user', store }),
});

await app.start();
store.close();
