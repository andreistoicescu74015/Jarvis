import { b, code, esc } from '../core/format.js';

/**
 * Manage the single owner slot. Public on purpose: `claim` must work for a
 * non-owner when the slot is free, so the command gates each action itself
 * (claim only if free, and only from a private chat - enforced by the dispatcher;
 * resign only by the owner) rather than declaring a scope.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'owner',
  summary: 'Claim or resign bot ownership (and show who owns it).',
  usage: 'jarvis owner | owner claim | owner resign',
  man:
    'Bare "jarvis owner" shows who owns the bot (or that no one does yet). "claim" takes ' +
    'a free owner slot; "resign" gives it up. The owner can also be set via OWNER_JID, in ' +
    'which case it cannot resign from chat.',
  params: [{ name: 'action', enum: ['claim', 'resign'], desc: 'claim a free owner slot, resign ownership, or omit to show who owns the bot' }],
  run: (ctx) => {
    if (!ctx.owner) return 'Owner management is unavailable here.';
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub) {
      return ctx.owner.exists
        ? `${b('Owner')}: ${code(esc(ctx.owner.contact))}`
        : `No owner yet. Send ${code('jarvis owner claim')} to become the owner.`;
    }

    if (sub === 'claim') {
      if (ctx.owner.exists) {
        return ctx.owner.isMe
          ? 'You are already the owner.'
          : `There is already an owner: ${code(esc(ctx.owner.contact))}.`;
      }
      return ctx.owner.claim()
        ? 'You are now the owner.'
        : 'To claim ownership, message me in a private chat (not from a group).';
    }

    if (sub === 'resign') {
      if (!ctx.owner.isMe) return 'Only the current owner can resign.';
      if (ctx.owner.fromEnv) return 'The owner is configured via OWNER_JID and cannot resign here.';
      ctx.owner.resign();
      return `You have resigned. Anyone can now claim ownership with ${code('jarvis owner claim')}.`;
    }

    return `Usage: ${code('jarvis owner | owner claim | owner resign')}`;
  },
};
