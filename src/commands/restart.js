/** @type {import('../core/registry.js').Command} */
export default {
  name: 'restart',
  summary: 'Owner: restart Jarvis (needs a process supervisor to come back up).',
  usage: 'jarvis restart',
  scope: { owner: true },
  run: (ctx) => {
    if (typeof ctx.lifecycle?.restart !== 'function') return 'Not available here.';
    ctx.lifecycle.restart();
    return 'Restarting...';
  },
};
