import { nullLogger } from './log.js';

/**
 * GitHub Models (OpenAI-compatible) client that translates a natural-language request into
 * exactly one command tool call. It is the ONLY non-deterministic part of the system and is
 * deliberately thin and best-effort: any failure - no token, network error, timeout, an
 * unexpected shape, or simply no matching command - resolves to null, so the deterministic
 * bot is never blocked by the AI (ADR-0003). The model only proposes a command; the
 * dispatcher still authorizes and runs it. `fetchImpl` is injectable so tests stay offline.
 *
 * The provider is a config triple (baseUrl / token / model): GitHub Models today, swappable
 * to any OpenAI-compatible endpoint (Azure AI Foundry, OpenAI, ...) with no code change.
 */

const SYSTEM_PROMPT = [
  'You are the command interpreter for a WhatsApp assistant named Jarvis.',
  'A user has addressed Jarvis in natural language (any language, including Romanian).',
  'Translate their request into one or more of the available command tools, called with the right arguments.',
  'Rules:',
  '- Map the request to tool calls. A multi-step request ("add everyone, then enable it") becomes several tool calls, in the order they should run. If nothing fits, call no tool.',
  '- Use ONLY the tools offered - they are exactly what is possible in this chat. Do not invent commands, or arguments the user did not imply.',
  '- "everyone" / "all" / "toata lumea" means the literal "*". Keep names, phone numbers, mentions and ids verbatim.',
].join('\n');

/**
 * @param {{
 *   token?: string,
 *   baseUrl?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   log?: import('./log.js').Logger,
 *   timeoutMs?: number,
 *   system?: string,
 * }} [opts]
 * @returns {{ translate: (input: { text: string, tools: object[] }) => Promise<Array<{ command: string, args: object }> | null> } | null}
 *   The client is null when no token is configured - AI is simply off and the caller stays
 *   deterministic-only. `translate` resolves to the model's tool calls (a chain, in order) or null.
 */
export function createAiClient({
  token = '',
  baseUrl = 'https://models.github.ai/inference',
  model = 'openai/gpt-4o-mini',
  fetchImpl = fetch,
  log = nullLogger,
  timeoutMs = 8000,
  system = SYSTEM_PROMPT,
} = {}) {
  if (!token) return null;

  async function translate({ text, tools } = {}) {
    if (!text || !Array.isArray(tools) || !tools.length) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          tools,
          tool_choice: 'auto', // let the model decline (no tool) when nothing matches
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn('ai: translation request failed', { status: res.status });
        return null;
      }
      const data = await res.json();
      const calls = data?.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(calls) || !calls.length) return null; // model called no tool -> no command matched
      const proposals = [];
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
        proposals.push({ command: name, args });
      }
      return proposals.length ? proposals : null;
    } catch (err) {
      log.warn('ai: translation error', { error: err?.message ?? String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { translate };
}
