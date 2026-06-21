import { b } from '../core/format.js';

/**
 * Owner: reset Jarvis's memory. "reset" clears THIS context (its data, access lists, and schedules)
 * from wherever it is run; "reset all" wipes EVERY context and restarts with a clean store, keeping
 * the WhatsApp login (it is NOT a logout). Owner-only and irreversible - run it deliberately.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'reset',
  summary: 'Owner: clear this context, or wipe everything.',
  usage: 'jarvis reset | reset all',
  man:
    "Clear Jarvis's stored data. \"reset\" wipes THIS context's data - the notes and schedules of the " +
    'chat you run it in (a linked group clears the shared cluster); access lists are left alone (a full ' +
    'access reset is what deactivate -> reactivate does). "reset all" wipes EVERY context - all notes, ' +
    'schedules, links, access lists, activations - and restarts with a clean store, keeping the WhatsApp ' +
    'login (it is NOT a logout). Owner-only and irreversible.',
  scope: { owner: true },
  params: [{ name: 'scope', enum: ['all'], desc: '"all" wipes every context and restarts clean; omit to reset just this chat' }],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'all') {
      if (typeof ctx.lifecycle?.wipe !== 'function') return 'Not available here.';
      ctx.lifecycle.wipe();
      return `${b('Wiping all data and restarting.')} Your WhatsApp login is kept.`;
    }
    if (typeof ctx.resetContext !== 'function') return 'Resetting is unavailable here.';
    ctx.resetContext();
    return 'This context is reset: its notes and schedules are cleared.';
  },
};
