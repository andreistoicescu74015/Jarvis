import { b, code, bullet, esc } from '../core/format.js';
import { checkScope } from '../core/scope.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'help',
  summary: 'List available commands.',
  usage: 'jarvis help | help owner | help admin',
  man:
    'List the commands you can run here. "jarvis help owner" narrows it to the owner-only commands and ' +
    '"jarvis help admin" to the admin-level ones (only those you can actually use). Use ' +
    '"jarvis man <command>" for one command\'s detail.',
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
    return [
      `I'm Jarvis. Address me with ${code('jarvis <command>')} or by @mentioning me.`,
      b('Commands'),
      bullet(items),
      `Try ${code('jarvis man <command>')} for details.`,
    ].join('\n');
  },
};
