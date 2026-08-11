/**
 * In-house send pacing + human-timing heuristics (anti-ban). We deliberately install no
 * anti-ban package - these are small, conservative helpers, treated as heuristics, not policy.
 *
 * `createRateLimiter` is the single GLOBAL limiter: one instance, applied to every outbound
 * send, so consecutive sends are at least `minIntervalMs` apart (a floor that never bursts,
 * even across chats). `typingDelayMs` derives a realistic "typing..." duration from a reply's
 * length, so the bot looks like it is composing rather than answering instantly. Both keep the
 * clock / randomness out (injected by the caller), so they are deterministic and unit-testable.
 */

/**
 * The global minimum-spacing limiter. `nextWaitMs` returns how long to wait before the next
 * send so sends stay at least `minIntervalMs` apart, plus any caller-supplied jitter. It
 * reserves the slot forward (so concurrent callers get staggered times), which is what keeps a
 * burst across different chats spaced.
 *
 * @param {{ minIntervalMs?: number, now?: () => number }} [opts]
 * @returns {{ nextWaitMs: (jitterMs?: number) => number }}
 */
export function createRateLimiter({ minIntervalMs = 800, now = () => Date.now() } = {}) {
  // Clamp to a non-negative integer so a stray env value can never make spacing nonsensical.
  const interval = Math.max(0, Math.floor(Number(minIntervalMs) || 0));
  let last = -Infinity; // scheduled time of the previous send

  return {
    /**
     * @param {number} [jitterMs] extra random delay the caller adds (>= 0).
     * @returns {number} milliseconds to wait before sending now.
     */
    nextWaitMs(jitterMs = 0) {
      const t = now();
      const sendAt = Math.max(t, last + interval) + Math.max(0, jitterMs);
      last = sendAt;
      return sendAt - t;
    },
  };
}

/**
 * A human-like "typing..." duration for a reply of `textLength` characters: linear in length
 * (`perCharMs` each) up to a `maxMs` ceiling, so a long reply does not keep the indicator up
 * absurdly long. Pure - the caller adds any jitter. Returns 0 for empty/garbage input.
 *
 * The ceiling is deliberately short. A person composing a long message really does take longer, but
 * a bot answering a typed command is not composing, and every second here is a second the user waits
 * after asking - a `help` that takes eight seconds reads as broken, not as human.
 *
 * @param {number} textLength
 * @param {{ perCharMs?: number, maxMs?: number }} [opts]
 * @returns {number} milliseconds to show "composing" before sending.
 */
export function typingDelayMs(textLength, { perCharMs = 50, maxMs = 2500 } = {}) {
  const len = Math.max(0, Math.floor(Number(textLength) || 0));
  const per = Math.max(0, Number(perCharMs) || 0);
  const cap = Math.max(0, Number(maxMs) || 0);
  return Math.min(cap, Math.floor(len * per));
}
