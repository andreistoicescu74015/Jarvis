import { b, code, bullet, esc } from '../core/format.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'help',
  summary: 'List available commands.',
  usage: 'jarvis help',
  run: (ctx) => {
    const items = ctx.commands
      .slice()
      .sort((a, b2) => a.name.localeCompare(b2.name))
      .map((c) => `${b(c.name)}: ${esc(c.summary)}`);
    return [b('Commands'), bullet(items), `Try ${code('jarvis man <command>')} for details.`].join('\n');
  },
};
