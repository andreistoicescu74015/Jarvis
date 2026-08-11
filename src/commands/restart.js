import { code } from '../core/format.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'restart',
  summary: 'Owner: restart Jarvis (needs a process supervisor to come back up).',
  usage: 'jarvis restart',
  man:
    'Bounces Jarvis: it confirms here, stops, and the container starts a fresh one. It is back in a few seconds.\n' +
    'Your data, the WhatsApp login and the ownership all survive it.\n' +
    `Run outside a container (a bare ${code('npm start')}), it just stops - nothing is there to bring it back.`,
  scope: { owner: true },
  confirm: true, // disruptive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.restart !== 'function') return 'Not available here.';
    ctx.lifecycle.restart();
    return 'Restarting...';
  },
};
