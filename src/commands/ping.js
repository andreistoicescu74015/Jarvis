/** @type {import('../core/registry.js').Command} */
export default {
  name: 'ping',
  summary: 'Check the bot is alive.',
  usage: 'jarvis ping',
  run: () => 'pong',
};
