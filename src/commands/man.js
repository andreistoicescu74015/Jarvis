import { b, code, esc } from '../core/format.js';

/**
 * Detailed help for one command: its summary, usage, who may use it (derived from
 * `scope`), and the long-form `man` text when the command provides one. `help`
 * lists the commands; `man` explains a single one.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'man',
  summary: 'Show detailed help for a command.',
  usage: 'jarvis man <command>',
  man:
    'Show the manual for a command: its summary, usage, who may use it, and any extra ' +
    'detail. Example: "jarvis man whitelist". Use "jarvis help" for the full list.',
  run: (ctx) => {
    const name = (ctx.args[0] ?? '').toLowerCase();
    if (!name) return `Usage: ${code('jarvis man <command>')}. Try ${code('jarvis help')} for the list.`;

    const cmd = ctx.commands.find((c) => c.name === name);
    if (!cmd) return `No such command: ${code(esc(name))}. Try ${code('jarvis help')}.`;

    const lines = [`${b(cmd.name)} - ${esc(cmd.summary)}`];
    if (cmd.usage) lines.push(`${b('Usage')}: ${code(cmd.usage)}`);
    lines.push(`${b('Who')}: ${audience(cmd.scope)}`);
    if (cmd.man) lines.push('', esc(cmd.man));
    return lines.join('\n');
  },
};

/** A human description of who may run a command, derived from its scope. */
function audience(scope) {
  if (!scope) return 'anyone';
  if (scope.owner) return 'the owner only';
  const parts = [];
  if (scope.admin) parts.push('group admins');
  if (scope.level) parts.push(`${scope.level} chats only`);
  return parts.length ? parts.join(', ') : 'anyone';
}
