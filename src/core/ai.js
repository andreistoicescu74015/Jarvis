import { nullLogger } from './log.js';

/**
 * GitHub Models (OpenAI-compatible) client. `translate` maps a natural-language request onto the
 * available command tools (a chain of one or more, in order) and - in chat mode - lets the model
 * answer a general question in plain text when nothing maps. It is the ONLY non-deterministic part
 * of the system and is deliberately thin and best-effort: any failure - no token, network error,
 * timeout, an unexpected shape - resolves to no commands and no answer, so the deterministic bot is
 * never blocked by the AI (ADR-0003). The model only PROPOSES commands; the dispatcher still
 * authorizes and runs each one. `fetchImpl` is injectable so tests stay offline.
 *
 * The provider is a config triple (baseUrl / token / model): GitHub Models today, swappable
 * to any OpenAI-compatible endpoint (Azure AI Foundry, OpenAI, ...) with no code change.
 */

// Translation-only: map to tools, or call no tool when nothing fits (no free-text answer).
const SYSTEM_PROMPT = [
  'You are the command interpreter for a WhatsApp assistant named Jarvis.',
  'A user has addressed Jarvis in natural language (any language, including Romanian).',
  'Translate their request into one or more of the available command tools, called with the right arguments.',
  'Rules:',
  '- Map the request to tool calls. A multi-step request ("add everyone, then enable it") becomes several tool calls, in the order they should run. If nothing fits, call no tool.',
  '- Use ONLY the tools offered - they are exactly what is possible in this chat. Do not invent commands, or arguments the user did not imply.',
  '- "everyone" / "all" / "toata lumea" means the literal "*". Keep names, phone numbers, mentions and ids verbatim.',
].join('\n');

// Chat mode (the owner enabled it with `jarvis ai on`): same tool-mapping, but when nothing maps the
// model answers the user directly, so Jarvis behaves like a normal assistant for general questions.
// The PERSONA (first line - Jarvis's voice) is owner-overridable via a file; the functional RULES
// below always apply, so a custom persona can change the tone but never loosen the tool discipline.
const CHAT_PERSONA = 'You are Jarvis, a helpful WhatsApp assistant.';
const CHAT_RULES = [
  'A user has addressed you in natural language (any language, including Romanian).',
  'If their request matches one of the available command tools, call it (one or more, in the order they should run) and do not also write a message.',
  'Otherwise, answer the user yourself - briefly and helpfully, in their language, as plain text (no markdown).',
  '- Use ONLY the tools offered for commands; do not invent commands or arguments the user did not imply.',
  '- "everyone" / "all" / "toata lumea" means the literal "*". Keep names, phone numbers, mentions and ids verbatim.',
];

/**
 * The chat-mode system prompt = a persona (Jarvis's voice) followed by the fixed functional rules. A
 * blank/whitespace persona falls back to the default voice. The rules are always appended, so an
 * owner-supplied persona changes only the tone, never the tool-use discipline.
 *
 * @param {string} [persona]
 * @returns {string}
 */
export function buildChatSystem(persona) {
  return [String(persona ?? '').trim() || CHAT_PERSONA, ...CHAT_RULES].join('\n');
}

const CHAT_SYSTEM_PROMPT = buildChatSystem();

/** Attach the provider's token usage to a translate result when the response reports it. */
const withUsage = (out, usage) => (usage ? { ...out, usage } : out);

/**
 * @param {{
 *   token?: string,
 *   baseUrl?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   log?: import('./log.js').Logger,
 *   timeoutMs?: number,
 *   maxTokens?: number,
 *   system?: string,
 *   chatSystem?: string,
 * }} [opts]
 * @returns {{ translate: (input: { text: string, tools: object[], chat?: boolean }) => Promise<{ commands: Array<{ command: string, args: object }>, answer: string | null, usage?: object, limit?: { type: string, retryAfterSec: number } }> } | null}
 *   The client is null when no token is configured - AI is simply off and the caller stays
 *   deterministic-only. `translate` resolves to the model's tool calls (`commands`, a chain in order)
 *   and, in chat mode when nothing maps, a plain-text `answer`. Both empty/null on any failure. A 429
 *   additionally carries `limit` (the provider throttle the response reported), for visibility.
 */
export function createAiClient({
  token = '',
  baseUrl = 'https://models.github.ai/inference',
  model = 'openai/gpt-4o-mini',
  fetchImpl = fetch,
  log = nullLogger,
  timeoutMs = 8000,
  maxTokens = 800,
  system = SYSTEM_PROMPT,
  chatSystem = CHAT_SYSTEM_PROMPT,
} = {}) {
  if (!token) return null;
  const EMPTY = { commands: [], answer: null };

  async function translate({ text, tools, chat = false } = {}) {
    if (!text || !Array.isArray(tools) || !tools.length) return EMPTY;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          // Bound one completion (cost discipline): tool calls are tiny, and a chat-mode answer on
          // WhatsApp should be short anyway - without this, a runaway answer's size is unbounded.
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: chat ? chatSystem : system },
            { role: 'user', content: text },
          ],
          tools,
          tool_choice: 'auto', // map to a tool, decline, or (in chat mode) answer in plain text
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // A 429 is the provider's rate limiter: capture what its headers say (the quota that tripped,
        // e.g. `UserByModelByDay`, and the advised wait) so the owner can SEE the throttle from
        // `jarvis ai` instead of guessing why the AI went quiet. Other failures stay a plain warn.
        if (res.status === 429) {
          const limit = {
            type: res.headers?.get?.('x-ratelimit-type') || '',
            retryAfterSec: Number(res.headers?.get?.('retry-after')) || 0,
          };
          log.warn('ai: provider rate limit hit', { status: 429, ...limit });
          return { ...EMPTY, limit };
        }
        log.warn('ai: request failed', { status: res.status });
        return EMPTY;
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      const calls = message?.tool_calls;
      if (Array.isArray(calls) && calls.length) {
        const commands = [];
        for (const call of calls) {
          const name = call?.function?.name;
          if (!name) continue;
          let args = {};
          try {
            const parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            if (parsed && typeof parsed === 'object') args = parsed;
          } catch {
            args = {}; // a malformed argument blob still yields a valid (argument-less) proposal
          }
          commands.push({ command: name, args });
        }
        return withUsage({ commands, answer: null }, data?.usage);
      }
      // No tool call: in chat mode the model's own text is the conversational answer; otherwise none.
      const content = typeof message?.content === 'string' ? message.content.trim() : '';
      return withUsage({ commands: [], answer: chat && content ? content : null }, data?.usage);
    } catch (err) {
      log.warn('ai: request error', { error: err?.message ?? String(err) });
      return EMPTY;
    } finally {
      clearTimeout(timer);
    }
  }

  return { translate };
}
