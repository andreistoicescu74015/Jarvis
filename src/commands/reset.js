import { b, code } from '../core/format.js';

/**
 * Owner: reset Jarvis's memory. "reset" clears THIS context's data (its notes, schedules, and
 * keyword auto-replies; NOT its access lists) from wherever it is run; "reset all" wipes EVERY context and
 * restarts with a clean store, keeping the WhatsApp login and the bot ownership (it is NOT a logout,
 * and a claimed owner stays the owner). Owner-only and irreversible - run it deliberately.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'reset',
  summary: 'Owner: clear this context, or wipe everything.',
  usage: 'jarvis reset | reset all',
  man:
    'Owner only, and irreversible.\n' +
    `${code('jarvis reset')} clears what THIS chat holds: its notes, scheduled messages and auto-replies. ` +
    'A linked group clears the notes it shares.\n' +
    'It leaves who may use Jarvis here untouched - that is what the whitelist and blacklist are for, ' +
    'and deactivating then reactivating a group is the full reset.\n' +
    `${code('jarvis reset all')} wipes every chat - notes, schedules, links, access lists, activations - and restarts clean.\n` +
    'Your WhatsApp login and the ownership survive it: this is not a logout, and it does not un-own the bot.',
  scope: { owner: true },
  confirm: true, // destructive - never auto-run from an AI translation; the user must type it
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
    return "Cleared this chat's notes, scheduled messages, and auto-replies. Who may use me here is unchanged.";
  },
};
