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
  summary: 'Show who you are (the owner can also look a person up).',
  usage: 'jarvis whoami | whoami <@user|number> (owner)',
  man:
    'Bare "whoami" shows who you are and where. The OWNER can also resolve a person - "whoami @user" or ' +
    '"whoami <number>" - to the canonical id Jarvis matches them by, handy when deciding who may use the ' +
    'bot in private (then "jarvis whitelist * add ...").',
  run: (ctx) => {
    // Owner-only person lookup: resolve an @mention or a typed number to the id Jarvis stores and
    // matches against. Anyone else (or the owner with no argument) just sees themselves.
    const named = ctx.mentions?.[0] ?? (ctx.args[0] || undefined);
    if (ctx.isOwner && named) {
      const id = ctx.resolveUser ? ctx.resolveUser(named) : String(named);
      return `${b(friendlyId(id))} - id ${code(esc(id))}.`;
    }
    const flags = [ctx.isOwner && 'owner', ctx.isAdmin && 'admin'].filter(Boolean);
    const suffix = flags.length ? ` ${i(`(${flags.join(', ')})`)}` : '';
    return `You are ${code(esc(friendlyId(ctx.sender)))} in a ${b(ctx.level)} chat${suffix}.`;
  },
};
