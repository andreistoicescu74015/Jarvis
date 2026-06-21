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
  summary: 'Owner: show who you are, or look a person up.',
  usage: 'jarvis whoami | whoami <@user|number>',
  man:
    'Owner-only. Bare "whoami" shows who you are, where, and the canonical id Jarvis knows you by - the ' +
    'value to set as OWNER_JID. "whoami @user" or "whoami <number>" resolves another person to that id, ' +
    'handy when deciding who may use the bot in private (then "jarvis whitelist * add ...").',
  scope: { owner: true },
  params: [{ name: 'person', desc: 'an @mention or phone number to look up; omit to show yourself' }],
  run: (ctx) => {
    // Owner-only command. With an argument, resolve an @mention or typed number to the id Jarvis
    // stores and matches against; with none, just show the owner themselves.
    const named = ctx.mentions?.[0] ?? (ctx.args[0] || undefined);
    if (named) {
      const id = ctx.resolveUser ? ctx.resolveUser(named) : String(named);
      return `${b(friendlyId(id))} - id ${code(esc(id))}.`;
    }
    const flags = [ctx.isOwner && 'owner', ctx.isAdmin && 'admin'].filter(Boolean);
    const suffix = flags.length ? ` ${i(`(${flags.join(', ')})`)}` : '';
    // Show the friendly form for readability AND the canonical id (the JID, copy-pasteable in inline
    // code) - the value to set as OWNER_JID or to whitelist, mirroring the person-lookup line above.
    return `You are ${b(friendlyId(ctx.sender))} in a ${b(ctx.level)} chat${suffix} - id ${code(esc(ctx.sender))}.`;
  },
};
