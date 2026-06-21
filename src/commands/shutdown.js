/** @type {import('../core/registry.js').Command} */
export default {
  name: 'shutdown',
  summary: 'Owner: stop Jarvis.',
  usage: 'jarvis shutdown',
  scope: { owner: true },
  confirm: true, // disruptive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.shutdown !== 'function') return 'Not available here.';
    ctx.lifecycle.shutdown();
    return 'Shutting down. See you.';
  },
};
