/**
 * In-house send pacing (anti-ban). We deliberately install no anti-ban package -
 * this is a small, conservative spacing limiter. `nextWaitMs` returns how long to
 * wait before the next send so consecutive sends are at least `minIntervalMs`
 * apart, plus any caller-supplied jitter. The clock is injected, so it is
 * deterministic and unit-testable. Treat the numbers as heuristics, not policy.
 *
 * @param {{ minIntervalMs?: number, now?: () => number }} [opts]
 * @returns {{ nextWaitMs: (jitterMs?: number) => number }}
 */
export function createRateLimiter({ minIntervalMs = 800, now = () => Date.now() } = {}) {
  let last = -Infinity; // scheduled time of the previous send

  return {
    /**
     * @param {number} [jitterMs] extra random delay the caller adds (>= 0).
     * @returns {number} milliseconds to wait before sending now.
     */
    nextWaitMs(jitterMs = 0) {
      const t = now();
      const sendAt = Math.max(t, last + minIntervalMs) + Math.max(0, jitterMs);
      last = sendAt;
      return sendAt - t;
    },
  };
}
