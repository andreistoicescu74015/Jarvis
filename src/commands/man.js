import { b, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

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
    'Shows one command in full: what it does, how to type it, who may use it, and the details.\n' +
    `Example: ${code('jarvis man whitelist')}.\n` +
    `${code('jarvis help')} lists every command instead.`,
  params: [{ name: 'command', desc: 'the command to explain, e.g. "whitelist" (omit to show usage)' }],
  run: (ctx) => {
    const name = (ctx.args[0] ?? '').toLowerCase();
    // A bare `man` is not a mis-usage: the intent is clear and the reply already points at the list,
    // so there is nothing for the AI layer to guess. A name it does not know IS one - the model can
    // map what the caller meant onto a real command.
    if (!name) return `Usage: ${code('jarvis man <command>')}. Try ${code('jarvis help')} for the list.`;

    const cmd = ctx.commands.find((c) => c.name === name);
    if (!cmd) return misuse(`No such command: ${code(esc(name))}. Try ${code('jarvis help')}.`);

    const lines = [`${b(cmd.name)} - ${esc(cmd.summary)}`];
    if (cmd.usage) lines.push(`${b('Usage')}: ${code(cmd.usage)}`);
    lines.push(`${b('Who')}: ${audience(cmd.scope)}`);
    // The man text is written by us, not typed by a user, so it is NOT escaped: escaping would strip
    // the formatting these pages rely on to stay readable on a phone (each rule on its own line, the
    // commands in monospace). `esc` guards interpolated user content; there is none here.
    if (cmd.man) lines.push('', cmd.man);
    return lines.join('\n');
  },
};

/** A human description of who may run a command, derived from its scope. */
function audience(scope) {
  if (!scope) return 'anyone';
  if (scope.owner) return 'the owner only';
  if (scope.ownerOrAdmin) return 'the owner, or a group admin in their own chat';
  const parts = [];
  if (scope.admin) parts.push('group admins');
  if (scope.level) parts.push(`${scope.level} chats only`);
  if (scope.proactive) parts.push('groups only (the owner excepted)');
  return parts.length ? parts.join('; ') : 'anyone';
}
