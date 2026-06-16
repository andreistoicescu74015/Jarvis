/** @type {import('../core/registry.js').Command} */
export default {
  name: 'restart',
  summary: 'Restart Jarvis (owner only; needs a process supervisor to come back up).',
  usage: 'jarvis restart',
  scope: { owner: true },
  run: (ctx) => {
    if (typeof ctx.lifecycle?.restart !== 'function') return 'Not available here.';
    ctx.lifecycle.restart();
    return 'Restarting...';
  },
};
