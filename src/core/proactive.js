/**
 * Generic background runner for proactive work. It calls `tick` on an interval, never
 * letting two ticks overlap (delivery is paced, so a tick can outrun the period), and the
 * timer is unref'd so it never keeps the process alive on its own. `stop()` awaits any
 * in-flight tick, so the shared store is never written after it closes. The first tick is
 * after one interval - we never act before the platform has connected.
 *
 * `tick` does one unit of proactive work (fire due scheduled messages, drain the broadcast
 * outbox); delivery is injected inside it, so this runner stays platform-agnostic.
 *
 * @param {() => Promise<unknown>} tick
 * @param {{ intervalMs?: number, log?: import('./log.js').Logger }} [opts]
 */
export function startProactive(tick, { intervalMs = 30_000, log } = {}) {
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;
  let running = false;
  let current = Promise.resolve(); // the in-flight tick, so stop() can await it
  const run = () => {
    if (running) return current;
    running = true;
    current = (async () => {
      try {
        await tick();
      } catch (err) {
        log?.error?.('proactive tick failed', { error: err?.message ?? String(err) });
      } finally {
        running = false;
      }
    })();
    return current;
  };
  const timer = setInterval(run, period);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await current;
    },
  };
}
