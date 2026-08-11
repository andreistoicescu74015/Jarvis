import { b, code, bullet, esc } from '../core/format.js';
import { checkScope } from '../core/scope.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'help',
  summary: 'List available commands.',
  usage: 'jarvis help | help owner | help admin',
  man:
    'Lists the commands you can run in this chat, grouped by who each one is for.\n' +
    `${code('jarvis help owner')} narrows it to the owner-only ones, ${code('jarvis help admin')} to the admin-level ones - only those you can actually use.\n` +
    `${code('jarvis man <command>')} explains a single command in detail.`,
  params: [{ name: 'role', enum: ['owner', 'admin'], desc: 'show only owner-only or admin-level commands, or omit for everything you can run here' }],
  run: (ctx) => {
    const role = (ctx.args[0] ?? '').toLowerCase();
    // Show only the commands the caller could actually run here (by scope), minus any hidden in this
    // context (e.g. `owner` once ownership is settled), so the list never advertises what is unusable.
    let cmds = ctx.commands.filter(
      (c) => !c.hidden?.(ctx) && checkScope(c.scope, { level: ctx.level, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner }).ok,
    );
    let heading = 'Commands';
    if (role === 'owner') {
      cmds = cmds.filter((c) => c.scope?.owner); // only the owner-gated ones
      heading = 'Owner-only commands';
    } else if (role === 'admin') {
      cmds = cmds.filter((c) => c.scope?.admin || c.scope?.ownerOrAdmin); // the admin-level ones
      heading = 'Admin commands';
    }
    const items = cmds.sort((a, b2) => a.name.localeCompare(b2.name)).map((c) => `${b(c.name)}: ${esc(c.summary)}`);
    // A focused (owner/admin) view is terse - no greeting - and says clearly when you have none of that kind.
    if (role === 'owner' || role === 'admin') {
      if (!items.length) return `No ${role} commands available to you here.`;
      return [b(heading), bullet(items), `Try ${code('jarvis man <command>')} for details.`].join('\n');
    }
    // The full list is grouped by who a command is for, not alphabetical: someone reading `help` for
    // the first time should meet what anyone can use before the owner's lifecycle switches, and the
    // headings tell them which of the three they are.
    const rank = (c) => (c.scope?.owner ? 2 : c.scope?.admin || c.scope?.ownerOrAdmin || c.scope?.proactive ? 1 : 0);
    const sections = [
      ['Commands', 0],
      ['For group admins', 1],
      ['For the owner', 2],
    ];
    const out = [`I'm Jarvis. Address me with ${code('jarvis <command>')} or by @mentioning me.`];
    for (const [title, r] of sections) {
      const of = cmds.filter((c) => rank(c) === r);
      if (of.length) out.push(b(title), bullet(of.map((c) => `${b(c.name)}: ${esc(c.summary)}`)));
    }
    out.push(`Try ${code('jarvis man <command>')} for details.`);
    return out.join('\n');
  },
};
