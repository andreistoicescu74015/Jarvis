/**
 * AI token accounting: record the token usage the model API reports for each `translate` call -
 * per access-context and globally - so the owner can SEE what the AI layer costs before we decide
 * whether to cap it. Storage-only and best-effort: a missing or token-less usage payload records
 * nothing and never throws. Lives behind the KV store like access/links/scheduler (ADR-0002).
 *
 * A bucket is `{ calls, prompt, completion, total, since }` stored in the `ai-usage` namespace,
 * keyed by the access context ('private' for any DM, else the chat id) and `*` for the running
 * global total. Totals are cumulative (with a `since` stamp); per-day buckets are deferred to the
 * future cap step - cumulative is enough to MEASURE.
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]  Injected epoch-ms clock for the `since` stamp (tests pass a fixed one).
 */
export function createAiUsage(store, { now = () => Date.now() } = {}) {
  const usage = store.scoped('ai-usage');
  const GLOBAL = '*';
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

  function read(key) {
    const v = usage.get(key);
    return {
      calls: num(v?.calls),
      prompt: num(v?.prompt),
      completion: num(v?.completion),
      total: num(v?.total),
      since: num(v?.since) || now(),
    };
  }

  function add(key, u) {
    const cur = read(key);
    usage.set(key, {
      calls: cur.calls + 1,
      prompt: cur.prompt + u.prompt,
      completion: cur.completion + u.completion,
      total: cur.total + u.total,
      since: cur.since,
    });
  }

  return {
    /**
     * Record one model call's usage for a context. `raw` is the provider's usage object
     * (OpenAI-compatible: `prompt_tokens` / `completion_tokens` / `total_tokens`). A nullish or
     * token-less payload is ignored. The global and per-context buckets move together (atomic).
     */
    record(context, raw) {
      const prompt = num(raw?.prompt_tokens);
      const completion = num(raw?.completion_tokens);
      const total = num(raw?.total_tokens) || prompt + completion;
      if (total <= 0) return;
      const u = { prompt, completion, total };
      store.transaction(() => {
        add(GLOBAL, u);
        if (context && context !== GLOBAL) add(context, u);
      });
    },
    /** Totals for one context plus the running global total, for display. */
    summary(context) {
      return { here: read(context), global: read(GLOBAL) };
    },
  };
}
