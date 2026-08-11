import { b, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

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
    'The owner is whoever manages Jarvis. They can use every command, in every chat.\n' +
    `${code('jarvis owner')} says whether the bot has one; who it is shows only to the owner themselves.\n` +
    `${code('jarvis owner claim')} takes the slot while it is free, and only from a private chat.\n` +
    `${code('jarvis owner resign')} gives it up again.\n` +
    `An owner set through the ${code('OWNER_JID')} setting cannot resign from chat - change the setting instead.`,
  // Sensitive (it changes who controls the bot): the AI translator never auto-runs it from a guess -
  // claiming or resigning ownership must be typed.
  confirm: true,
  // Hide from `help` once ownership is settled and the command is no longer actionable for the caller:
  // an owner exists AND you are not a claimed owner who could resign (claim is taken; an env owner can't
  // resign). At bootstrap (no owner) it stays listed so it can be claimed. It still runs and shows in `man`.
  hidden: (ctx) => !!ctx.owner?.exists && !(ctx.owner?.isMe && !ctx.owner?.fromEnv),
  params: [{ name: 'action', enum: ['claim', 'resign'], desc: 'claim a free owner slot, resign ownership, or omit to show who owns the bot' }],
  run: (ctx) => {
    if (!ctx.owner) return 'Owner management is unavailable here.';
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub) {
      if (!ctx.owner.exists) return `No owner yet. Send ${code('jarvis owner claim')} to become the owner.`;
      // The contact is shown only to the owner themselves: it is a personal id (usually the owner's
      // phone number), and anyone who can address the bot can run this command - never leak it.
      return ctx.owner.isMe ? `${b('Owner')}: ${code(esc(ctx.owner.contact))}` : 'This bot already has an owner.';
    }

    if (sub === 'claim') {
      if (ctx.owner.exists) {
        // Same privacy rule as the bare show: a would-be claimer learns the slot is taken, not whose it is.
        return ctx.owner.isMe ? 'You are already the owner.' : 'There is already an owner.';
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

    return misuse(`Usage: ${code('jarvis owner | owner claim | owner resign')}`);
  },
};
