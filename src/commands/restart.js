/** @type {import('../core/registry.js').Command} */
export default {
  name: 'restart',
  summary: 'Owner: restart Jarvis (needs a process supervisor to come back up).',
  usage: 'jarvis restart',
  man:
    'Bounce Jarvis: it confirms here, then exits with a failure code so the process supervisor starts ' +
    'a fresh one - it comes back on its own in a few seconds. Data, the WhatsApp login and the ' +
    'ownership all survive. Without a supervisor (a bare "npm start") it just stops.',
  scope: { owner: true },
  confirm: true, // disruptive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.restart !== 'function') return 'Not available here.';
    ctx.lifecycle.restart();
    return 'Restarting...';
  },
};
