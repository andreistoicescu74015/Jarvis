import { b, i, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

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
  usage: 'jarvis whoami | whoami <@user|number> | whoami forget <@user|number>',
  man:
    'Owner only.\n' +
    `${code('jarvis whoami')} shows who you are here and the id Jarvis knows you by - the value to put in the ${code('OWNER_JID')} setting.\n` +
    `${code('jarvis whoami @user')} (a phone number works too) resolves someone else to that id, which is what the access lists match on.\n` +
    `${code('jarvis whoami forget @user')} drops what Jarvis learned about them, for a number that changed hands; it is learned again from their next message.`,
  scope: { owner: true },
  params: [{ name: 'person', desc: 'an @mention or phone number to look up; omit to show yourself' }],
  run: (ctx) => {
    // Maintenance escape hatch: drop a person's stored identity mapping (see the identity store's
    // self-heal - this is the manual counterpart). Typed-only on purpose (not offered as an AI tool
    // param): it is a rare repair action, and the person token follows right after.
    if ((ctx.args[0] ?? '').toLowerCase() === 'forget') {
      if (typeof ctx.forgetIdentity !== 'function') return 'Identity management is unavailable here.';
      const target = ctx.mentions?.[0] ?? (ctx.args[1] || '');
      if (!target) return misuse(`Usage: ${code('jarvis whoami forget <@user|number>')}`);
      return ctx.forgetIdentity(target)
        ? `Forgot the stored identity mapping for ${b(friendlyId(String(target)))} - it will be re-learned from their next message.`
        : 'Nothing stored for that person.';
    }
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
