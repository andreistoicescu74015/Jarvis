/** @type {import('../core/registry.js').Command} */
export default {
  name: 'whoami',
  summary: 'Show who you are and where.',
  usage: 'jarvis whoami',
  run: (ctx) => {
    const flags = [ctx.isOwner && 'owner', ctx.isAdmin && 'admin'].filter(Boolean);
    const suffix = flags.length ? ` (${flags.join(', ')})` : '';
    return `You are ${ctx.sender || 'unknown'} in a ${ctx.level} chat${suffix}.`;
  },
};
