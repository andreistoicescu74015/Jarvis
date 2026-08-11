import { b, i, code, bullet, page, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

const PAGE = 20; // shortcuts shown by one listing; the owner may hold 200, which no message fits

/**
 * Owner-only: define short command aliases (shortcuts) that expand to a full command line and run
 * deterministically - no AI, no tokens - before the AI translation branch. `jarvis alias add <name>
 * <command...>` defines one; `alias list` shows them; `alias remove <name>` deletes one. Anyone who may
 * use Jarvis can then trigger an alias, but its target still passes every permission guard (so an alias
 * can never run a command the caller could not type by hand).
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'alias',
  summary: 'Owner: define command shortcuts that expand to a full command.',
  usage: 'jarvis alias add <name> <command...> | list | remove <name>',
  man:
    'Owner-only shortcuts, run without any AI.\n' +
    `${code('jarvis alias add gm note add Good morning')} makes ${code('jarvis gm')} save that note.\n` +
    `Whatever you type after the shortcut is added on, so ${code('jarvis alias add w whitelist')} lets you run ${code('jarvis w * disable')}.\n` +
    `${code('jarvis alias list')} shows them, ${code('jarvis alias remove <name>')} deletes one.\n` +
    'A name is a single word and can never shadow a real command.\n' +
    'Anyone who may use Jarvis here can trigger a shortcut, but what it runs still passes every permission check.',
  scope: { owner: true },
  requires: ['aliases'],
  params: [
    { name: 'action', enum: ['add', 'list', 'remove'], required: true, desc: 'add a shortcut, list them, or remove one' },
    { name: 'rest', variadic: true, desc: 'for "add" it is "<name> <command...>"; for "remove" it is the name' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub || sub === 'list') {
      const all = ctx.aliases.list();
      if (!all.length) return 'No aliases defined.';
      const { shown, hidden, total } = page(all, { limit: PAGE });
      const out = [b('Aliases'), bullet(shown.map((a) => `${code(a.name)} -> ${esc(a.target)}`))];
      if (hidden) out.push(i(`Showing ${shown.length} of ${total}, alphabetically.`));
      return out.join('\n');
    }

    if (sub === 'add') {
      const name = (ctx.args[1] ?? '').toLowerCase();
      const target = ctx.args.slice(2).join(' ').trim();
      if (!name || !target) return misuse(`Usage: ${code('jarvis alias add <name> <command...>')}`);
      if (ctx.commands.some((c) => c.name === name)) return `${code(esc(name))} is a built-in command - pick another alias name.`;
      const r = ctx.aliases.define(name, target);
      if (r.ok) return `Alias ${code(r.name)} -> ${code(esc(r.target))} saved.`;
      return r.reason === 'bad-name'
        ? 'An alias name must be a single word (letters, digits, - or _).'
        : r.reason === 'empty-target'
          ? 'Give a command for the alias to run.'
          : r.reason === 'too-long'
            ? `That command is too long (max ${r.max} characters).`
            : `Too many aliases (max ${r.max}); remove some first.`;
    }

    if (sub === 'remove') {
      const name = (ctx.args[1] ?? '').toLowerCase();
      if (!name) return misuse(`Usage: ${code('jarvis alias remove <name>')}`);
      return ctx.aliases.remove(name) ? `Removed alias ${code(name)}.` : `No alias "${esc(name)}".`;
    }

    return misuse(`Usage: ${code('jarvis alias add <name> <command...> | list | remove <name>')}`);
  },
};
