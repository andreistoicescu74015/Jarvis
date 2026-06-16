/**
 * Manage the single owner slot. Public on purpose: `claim` must work for a
 * non-owner when the slot is free, so the command gates each action itself
 * (claim only if free; resign only by the owner) rather than declaring a scope.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'owner',
  summary: 'Show, claim, or resign the bot owner.',
  usage: 'jarvis owner | owner claim | owner resign',
  run: (ctx) => {
    if (!ctx.owner) return 'Owner management is unavailable here.';
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub) {
      return ctx.owner.exists
        ? `Owner: ${ctx.owner.contact}.`
        : 'No owner yet. Send "jarvis owner claim" to become the owner.';
    }

    if (sub === 'claim') {
      if (ctx.owner.exists) {
        return ctx.owner.isMe ? 'You are already the owner.' : `There is already an owner: ${ctx.owner.contact}.`;
      }
      ctx.owner.claim();
      return 'You are now the owner.';
    }

    if (sub === 'resign') {
      if (!ctx.owner.isMe) return 'Only the current owner can resign.';
      if (ctx.owner.fromEnv) return 'The owner is configured via OWNER_JID and cannot resign here.';
      ctx.owner.resign();
      return 'You have resigned. Anyone can now claim ownership with "jarvis owner claim".';
    }

    return 'Usage: jarvis owner | owner claim | owner resign';
  },
};
