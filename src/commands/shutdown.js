import { code } from '../core/format.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'shutdown',
  summary: 'Owner: stop Jarvis.',
  usage: 'jarvis shutdown',
  man:
    'Stops Jarvis. It confirms here, then exits.\n' +
    'A clean stop STAYS stopped: the container only comes back after a failure, so nothing restarts it.\n' +
    `Start it again yourself with ${code('docker compose up -d')} on the machine it runs on.\n` +
    `Use ${code('jarvis restart')} if you only meant to bounce it.`,
  scope: { owner: true },
  confirm: true, // disruptive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.shutdown !== 'function') return 'Not available here.';
    ctx.lifecycle.shutdown();
    return 'Shutting down. See you.';
  },
};
