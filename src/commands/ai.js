import { b, code } from '../core/format.js';

const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A one-line token-usage summary for the owner, shown once the AI has actually been used. */
function usageLine(ctx) {
  if (!ctx.aiUsage) return '';
  const { here, global } = ctx.aiUsage.summary();
  if (!global.total) return '';
  const calls = (n) => `${group(n)} call${n === 1 ? '' : 's'}`;
  return `\nTokens used - here: ${group(here.total)} (${calls(here.calls)}); all chats: ${group(global.total)} (${calls(global.calls)}).`;
}

/**
 * Owner-only: turn CHATBOT mode on or off for THIS chat. Natural-language command translation is
 * always on (anyone who may use Jarvis here can phrase a command in plain language); this toggle only
 * controls whether Jarvis ALSO answers general questions conversationally when nothing maps to a
 * command. Off by default. "ai" alone shows the state.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ai',
  summary: 'Owner: let Jarvis also answer general questions here (chatbot mode).',
  usage: 'jarvis ai | ai on | ai off',
  man:
    'Natural-language command translation is ALWAYS on - anyone who may use Jarvis here can phrase a ' +
    'command in plain language, and it maps to the matching command(s). "ai on" ADDITIONALLY lets ' +
    'Jarvis answer general questions in THIS chat like a normal assistant (e.g. "jarvis how big is a ' +
    'lemon"); "ai off" restricts it back to commands only; "ai" alone shows the state and the AI ' +
    'tokens used so far. Sensitive ' +
    'commands are only ever suggested, never auto-run. Needs an AI provider (GITHUB_MODELS_TOKEN).',
  scope: { owner: true },
  requires: ['aiGate'],
  params: [{ name: 'action', enum: ['on', 'off'], desc: 'turn chatbot mode on/off for this chat, or omit to show the state' }],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    const note = ctx.aiGate.available ? '' : `\n${b('No AI provider is configured')} - set GITHUB_MODELS_TOKEN for this to take effect.`;
    if (sub === 'on') {
      ctx.aiGate.on();
      return `Chatbot mode is ${b('on')} here - I'll also answer general questions.${note}`;
    }
    if (sub === 'off') {
      ctx.aiGate.off();
      return `Chatbot mode is ${b('off')} here - I'll stick to commands.${note}`;
    }
    if (sub) return `Usage: ${code('jarvis ai | ai on | ai off')}`;
    return `Chatbot mode is ${b(ctx.aiGate.isOn() ? 'on' : 'off')} here.${note}${usageLine(ctx)}`;
  },
};
