/** @type {import('../core/registry.js').Command} */
export default {
  name: 'shutdown',
  summary: 'Owner: stop Jarvis.',
  usage: 'jarvis shutdown',
  man:
    'Stop Jarvis. It confirms here, then exits cleanly, and a clean exit STAYS down - the container is ' +
    'set to come back only after a failure, so nothing restarts it. Bring it back yourself with ' +
    '"docker compose up -d". Use "restart" if you only want to bounce it.',
  scope: { owner: true },
  confirm: true, // disruptive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.shutdown !== 'function') return 'Not available here.';
    ctx.lifecycle.shutdown();
    return 'Shutting down. See you.';
  },
};
