import { b, i, code, esc } from '../core/format.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'whoami',
  summary: 'Show who you are and where.',
  usage: 'jarvis whoami',
  run: (ctx) => {
    const flags = [ctx.isOwner && 'owner', ctx.isAdmin && 'admin'].filter(Boolean);
    const suffix = flags.length ? ` ${i(`(${flags.join(', ')})`)}` : '';
    return `You are ${code(esc(ctx.sender || 'unknown'))} in a ${b(ctx.level)} chat${suffix}.`;
  },
};
