import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import ping from './commands/ping.js';
import help from './commands/help.js';

const registry = createRegistry([ping, help]);
const app = createApp(createCliAdapter(), { handle: createDispatcher(registry) });

await app.start();
