import { b, code, bullet, esc } from '../core/format.js';
import { checkScope } from '../core/scope.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'help',
  summary: 'List available commands.',
  usage: 'jarvis help',
  run: (ctx) => {
    // Show only the commands the caller could actually run here (by scope), so the list
    // does not advertise owner/admin-only commands to someone who would just be refused.
    const items = ctx.commands
      .filter((c) => checkScope(c.scope, { level: ctx.level, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner }).ok)
      .sort((a, b2) => a.name.localeCompare(b2.name))
      .map((c) => `${b(c.name)}: ${esc(c.summary)}`);
    return [
      `I'm Jarvis. Address me with ${code('jarvis <command>')} or by @mentioning me.`,
      b('Commands'),
      bullet(items),
      `Try ${code('jarvis man <command>')} for details.`,
    ].join('\n');
  },
};
