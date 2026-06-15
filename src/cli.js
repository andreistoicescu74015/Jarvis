import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import ping from './commands/ping.js';
import help from './commands/help.js';
import whoami from './commands/whoami.js';

// In CLI dev you are the owner (owner-only commands work).
const registry = createRegistry([ping, help, whoami]);
const app = createApp(createCliAdapter(), {
  handle: createDispatcher(registry, { owner: 'cli-user' }),
});

await app.start();
