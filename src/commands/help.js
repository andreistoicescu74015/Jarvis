/** @type {import('../core/registry.js').Command} */
export default {
  name: 'help',
  summary: 'List available commands.',
  usage: 'jarvis help',
  run: (ctx) => {
    const lines = ctx.commands
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `- ${c.name}: ${c.summary}`);
    return ['Commands:', ...lines].join('\n');
  },
};
