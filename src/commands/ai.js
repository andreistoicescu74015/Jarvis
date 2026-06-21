import { b, code } from '../core/format.js';

/**
 * Owner-only: turn AI command-translation on or off for THIS chat. AI is off by default and the
 * owner can always use it; turning it on opens it to everyone else who may use the bot here, so they
 * too can phrase a command in natural language. "ai" alone shows the state. The translator only
 * proposes a command - every permission check still applies - so this grants convenience, not power.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ai',
  summary: 'Owner: turn natural-language command translation on/off for this chat.',
  usage: 'jarvis ai | ai on | ai off',
  man:
    'Natural-language command translation. Off by default; the owner can always use it. "ai on" lets ' +
    'everyone who may use Jarvis in THIS chat phrase a command in plain language too (e.g. "jarvis ' +
    'activeaza whitelist pt toata lumea" becomes "jarvis whitelist * enable"); "ai off" restricts it ' +
    'back to the owner; "ai" alone shows the state. The translator only proposes a command - every ' +
    'permission check still applies. Needs an AI provider configured (GITHUB_MODELS_TOKEN).',
  scope: { owner: true },
  requires: ['aiGate'],
  params: [{ name: 'action', enum: ['on', 'off'], desc: 'turn translation on/off for everyone here, or omit to show the state' }],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    const note = ctx.aiGate.available ? '' : `\n${b('No AI provider is configured')} - set GITHUB_MODELS_TOKEN for this to take effect.`;
    if (sub === 'on') {
      ctx.aiGate.on();
      return `Natural-language translation is ${b('on')} for everyone here.${note}`;
    }
    if (sub === 'off') {
      ctx.aiGate.off();
      return `Natural-language translation is ${b('off')} here - the owner can still use it.${note}`;
    }
    if (sub) return `Usage: ${code('jarvis ai | ai on | ai off')}`;
    return `Natural-language translation is ${b(ctx.aiGate.isOn() ? 'on' : 'off')} here.${note}`;
  },
};
