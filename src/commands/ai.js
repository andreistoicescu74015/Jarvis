import { b, code } from '../core/format.js';

const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A usage summary for the owner: cumulative token totals once the AI has been used, today's spend vs
 * the daily cap (when configured), the provider's DOCUMENTED ceilings (static, tier+plan from env),
 * and the last provider throttle seen - budget and platform limits visible from one place. */
function usageLine(ctx) {
  if (!ctx.aiUsage) return '';
  const { here, global } = ctx.aiUsage.summary();
  const calls = (n) => `${group(n)} call${n === 1 ? '' : 's'}`;
  let out = '';
  if (global.total) {
    out += `\nTokens used - here: ${group(here.total)} (${calls(here.calls)}); all chats: ${group(global.total)} (${calls(global.calls)}).`;
  }
  const cap = ctx.aiUsage.cap ?? 0;
  if (cap > 0) {
    const today = ctx.aiUsage.today();
    out += `\nToday: ${group(today)} / ${group(cap)} daily cap${today >= cap ? ' (reached - AI paused until tomorrow)' : ''}.`;
  }
  // The provider's own documented ceilings, with today's request count against the requests/day one -
  // the limit a chatty day actually hits first on GitHub Models.
  const p = ctx.aiUsage.provider;
  if (p) {
    out +=
      `\nProvider (GitHub Models, ${p.tier}-tier model, Copilot ${p.plan}): today ${group(ctx.aiUsage.todayCalls())} / ${group(p.rpd)} requests; ` +
      `${group(p.rpm)}/min; ${group(p.tokensIn)} in / ${group(p.tokensOut)} out tokens per request ${b(`(documented ${p.docDate})`)}.`;
  }
  const hit = ctx.aiUsage.lastLimit ? ctx.aiUsage.lastLimit() : undefined;
  if (hit) {
    const d = new Date(hit.at);
    const pad = (n) => String(n).padStart(2, '0');
    const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    out += `\nLast provider throttle: ${hit.type || '429'} at ${at}${hit.retryAfterSec ? ` (retry after ${group(hit.retryAfterSec)}s)` : ''}.`;
  }
  return out;
}

/**
 * Owner-only: turn CHATBOT mode on or off. Natural-language command translation is always on (anyone
 * who may use Jarvis here can phrase a command in plain language); this toggle only controls whether
 * Jarvis ALSO answers general questions conversationally when nothing maps to a command. Per-CHAT -
 * each DM and each group has its own switch - with `all` as a global default that a later per-chat
 * `ai off` can still override. Off by default. "ai" alone shows the state plus the AI usage and the
 * provider's documented rate limits.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ai',
  summary: 'Owner: let Jarvis also answer general questions here (chatbot mode).',
  usage: 'jarvis ai | ai on [all] | ai off [all]',
  man:
    'Natural-language command translation is ALWAYS on - anyone who may use Jarvis here can phrase a ' +
    'command in plain language, and it maps to the matching command(s). "ai on" ADDITIONALLY lets ' +
    'Jarvis answer general questions in THIS chat like a normal assistant (each DM and each group is ' +
    'its own switch); "ai off" restricts this chat back to commands only. "ai on all" / "ai off all" ' +
    'set the default for every chat at once (clearing per-chat overrides; a later per-chat toggle ' +
    'still wins here). "ai" alone shows the state, the tokens/requests used, the provider\'s ' +
    'documented rate limits (set JARVIS_AI_MODEL_TIER and JARVIS_AI_PLAN to match your account), and ' +
    'the last provider throttle, if any. Sensitive commands are only ever suggested, never auto-run. ' +
    'Needs an AI provider (GITHUB_MODELS_TOKEN).',
  scope: { owner: true },
  requires: ['aiGate'],
  params: [
    { name: 'action', enum: ['on', 'off'], desc: 'turn chatbot mode on/off, or omit to show the state and limits' },
    { name: 'scope', enum: ['all'], desc: 'apply to every chat instead of only this one' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    const scope = (ctx.args[1] ?? '').toLowerCase();
    const note = ctx.aiGate.available ? '' : `\n${b('No AI provider is configured')} - set GITHUB_MODELS_TOKEN for this to take effect.`;
    if (sub && sub !== 'on' && sub !== 'off') return `Usage: ${code('jarvis ai | ai on [all] | ai off [all]')}`;
    if (sub && scope && scope !== 'all') return `Usage: ${code('jarvis ai | ai on [all] | ai off [all]')}`;
    if (sub === 'on') {
      if (scope === 'all') {
        ctx.aiGate.onAll();
        return `Chatbot mode is ${b('on everywhere')} (per-chat overrides cleared) - ${code('jarvis ai off')} in a chat opts it back out.${note}`;
      }
      ctx.aiGate.on();
      return `Chatbot mode is ${b('on')} in this chat - I'll also answer general questions here.${note}`;
    }
    if (sub === 'off') {
      if (scope === 'all') {
        ctx.aiGate.offAll();
        return `Chatbot mode is ${b('off everywhere')} (per-chat overrides cleared).${note}`;
      }
      ctx.aiGate.off();
      return `Chatbot mode is ${b('off')} in this chat - I'll stick to commands here.${note}`;
    }
    const s = ctx.aiGate.state();
    // Say where the state comes from when it is not the plain default: an explicit per-chat setting,
    // or the global `ai on all`.
    const source = typeof s.own === 'boolean' ? 'set for this chat' : s.global ? `on everywhere via ${code('jarvis ai on all')}` : '';
    return `Chatbot mode is ${b(s.here ? 'on' : 'off')} here${source ? ` - ${source}` : ''}.${note}${usageLine(ctx)}`;
  },
};
