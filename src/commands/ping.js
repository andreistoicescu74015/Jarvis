/** @type {import('../core/registry.js').Command} */
export default {
  name: 'ping',
  summary: 'Check the bot is alive.',
  usage: 'jarvis ping',
  man: 'Answers "pong" if Jarvis is running and can reach this chat. It touches nothing and needs no permissions.',
  run: () => 'pong',
};
