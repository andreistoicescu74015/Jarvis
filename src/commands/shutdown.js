/** @type {import('../core/registry.js').Command} */
export default {
  name: 'shutdown',
  summary: 'Stop Jarvis (owner only).',
  usage: 'jarvis shutdown',
  scope: { owner: true },
  run: (ctx) => {
    if (typeof ctx.lifecycle?.shutdown !== 'function') return 'Not available here.';
    ctx.lifecycle.shutdown();
    return 'Shutting down. See you.';
  },
};
