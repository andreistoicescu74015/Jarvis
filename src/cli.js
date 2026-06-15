import { createApp } from './core/app.js';
import { createCliAdapter } from './cli/adapter.js';

// Placeholder handler: echo the message. Replaced by the dispatcher (next issue).
const app = createApp(createCliAdapter(), {
  handle: (msg) => `you said: ${msg.text}`,
});

await app.start();
