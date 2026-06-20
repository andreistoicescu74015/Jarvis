import { b, i, code, esc } from '../core/format.js';

/** A readable id for a sender: the phone number for a WhatsApp user, else the bare user part. */
function friendlyId(sender) {
  const s = String(sender || 'unknown');
  if (!s.includes('@')) return s; // already friendly (e.g. the CLI 'cli-user')
  const user = s.split('@')[0].split(':')[0]; // drop the domain and any :device suffix
  return s.includes('@s.whatsapp.net') ? `+${user}` : user; // a phone JID -> +number; a LID -> bare id
}

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'whoami',
  summary: 'Show who you are and where.',
  usage: 'jarvis whoami',
  run: (ctx) => {
    const flags = [ctx.isOwner && 'owner', ctx.isAdmin && 'admin'].filter(Boolean);
    const suffix = flags.length ? ` ${i(`(${flags.join(', ')})`)}` : '';
    return `You are ${code(esc(friendlyId(ctx.sender)))} in a ${b(ctx.level)} chat${suffix}.`;
  },
};
