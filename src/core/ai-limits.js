/**
 * GitHub Models DOCUMENTED rate limits, so the owner can see the provider's ceilings next to
 * Jarvis's own spend (`jarvis ai`). STATIC by necessity: the inference API does not expose
 * remaining-quota headers on successful responses - only a 429 carries `x-ratelimit-type` (e.g.
 * `UserByModelByDay`) and `retry-after`, which the AI client captures separately. Source:
 * docs.github.com "Rate limits for GitHub Models" (retrieved 2026-07-04); update by hand when
 * GitHub revises the tables.
 *
 * A model's TIER ("low" / "high") is shown on its GitHub Marketplace model card; the default
 * `openai/gpt-4o-mini` is a low-tier model. The PLAN is the account's Copilot plan. Both are env
 * knobs at the composition root (JARVIS_AI_MODEL_TIER / JARVIS_AI_PLAN), since neither is
 * discoverable through the API.
 */

export const LIMITS_DOC_DATE = '2026-07-04';

// requests/minute, requests/day, tokens in/out per request, concurrent requests.
const TABLE = {
  low: {
    free: { rpm: 15, rpd: 150, tokensIn: 8000, tokensOut: 4000, concurrent: 5 },
    pro: { rpm: 15, rpd: 150, tokensIn: 8000, tokensOut: 4000, concurrent: 5 },
    business: { rpm: 15, rpd: 300, tokensIn: 8000, tokensOut: 4000, concurrent: 5 },
    enterprise: { rpm: 20, rpd: 450, tokensIn: 8000, tokensOut: 8000, concurrent: 8 },
  },
  high: {
    free: { rpm: 10, rpd: 50, tokensIn: 8000, tokensOut: 4000, concurrent: 2 },
    pro: { rpm: 10, rpd: 50, tokensIn: 8000, tokensOut: 4000, concurrent: 2 },
    business: { rpm: 10, rpd: 100, tokensIn: 8000, tokensOut: 4000, concurrent: 2 },
    enterprise: { rpm: 15, rpd: 150, tokensIn: 16000, tokensOut: 8000, concurrent: 4 },
  },
};

/**
 * The documented limits for a model tier + Copilot plan, or undefined for an unknown combination
 * (e.g. a custom endpoint where the table does not apply - the display simply omits the line).
 *
 * @param {string} [tier]  'low' | 'high' (the model card's rate limit tier).
 * @param {string} [plan]  'free' | 'pro' | 'business' | 'enterprise' (the Copilot plan).
 * @returns {{ rpm: number, rpd: number, tokensIn: number, tokensOut: number, concurrent: number } | undefined}
 */
export function providerLimits(tier = 'low', plan = 'free') {
  const t = String(tier ?? '').trim().toLowerCase();
  const p = String(plan ?? '').trim().toLowerCase();
  return TABLE[t]?.[p];
}
