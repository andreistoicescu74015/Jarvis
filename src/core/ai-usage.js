/**
 * AI token accounting: record the token usage the model API reports for each `translate` call -
 * per access-context and globally - so the owner can SEE what the AI layer costs before we decide
 * whether to cap it. Storage-only and best-effort: a missing or token-less usage payload records
 * nothing and never throws. Lives behind the KV store like access/links/scheduler (ADR-0002).
 *
 * A bucket is `{ calls, prompt, completion, total, since }` stored in the `ai-usage` namespace,
 * keyed by the access context ('private' for any DM, else the chat id) and `*` for the running
 * global total. Totals are cumulative (with a `since` stamp). A separate self-resetting `#today`
 * bucket holds the current local day's global total, which `allows(cap)` gates for the daily budget.
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]  Injected epoch-ms clock for the `since` stamp (tests pass a fixed one).
 */
export function createAiUsage(store, { now = () => Date.now() } = {}) {
  const usage = store.scoped('ai-usage');
  const GLOBAL = '*';
  const TODAY = '#today'; // a single self-resetting bucket: { date, total, calls } for the current local day
  const LIMIT = '#limit'; // the last provider throttle seen (a 429): { at, type, retryAfterSec }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

  // Server-local calendar day as YYYY-MM-DD - the daily-budget window (matches the TZ used for schedules).
  const dayStr = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // Today's global bucket; a stale one (its date is not today) reads as empty - the day rolled over.
  const todayBucket = () => {
    const cur = usage.get(TODAY);
    return cur && cur.date === dayStr(now()) ? { total: num(cur.total), calls: num(cur.calls) } : { total: 0, calls: 0 };
  };
  const todayTotal = () => todayBucket().total;

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
        // Bump the daily bucket's TOKENS (the budget `allows` gates). The daily request count is
        // `noteCall`'s job - counted per ATTEMPT, before the response - so 429s/timeouts/failures
        // (real provider requests that carry no usage payload) are never missing from it.
        const t = todayBucket();
        usage.set(TODAY, { date: dayStr(now()), total: t.total + total, calls: t.calls });
      });
    },
    /**
     * Count one model REQUEST against today's requests/day view. Called at the chokepoint right
     * before the provider call, so throttled (429) and failed requests count too - the display
     * exists precisely to explain the days the provider starts rejecting.
     */
    noteCall() {
      const t = todayBucket();
      usage.set(TODAY, { date: dayStr(now()), total: t.total, calls: t.calls + 1 });
    },
    /**
     * Remember a provider throttle (a 429): what tripped (`type`, e.g. `UserByModelByDay`) and the
     * advised wait. One snapshot - the LAST one is what the owner needs to see in `jarvis ai`.
     */
    noteLimit({ type = '', retryAfterSec = 0 } = {}) {
      usage.set(LIMIT, { at: now(), type: String(type), retryAfterSec: num(retryAfterSec) });
    },
    /** The last provider throttle seen, or undefined if none was ever recorded. */
    lastLimit() {
      const v = usage.get(LIMIT);
      return v ? { at: num(v.at), type: String(v.type ?? ''), retryAfterSec: num(v.retryAfterSec) } : undefined;
    },
    /** Model calls made so far in the current server-local day (vs the provider's requests/day cap). */
    todayCalls: () => todayBucket().calls,
    /** Totals for one context plus the running global total, for display. */
    summary(context) {
      return { here: read(context), global: read(GLOBAL) };
    },
    /** Total tokens spent so far in the current server-local day (the daily-budget window). */
    today: todayTotal,
    /** Is another model call within the daily token budget? `cap <= 0` means no cap (always allowed). */
    allows(cap) {
      return !(cap > 0) || todayTotal() < cap;
    },
  };
}
