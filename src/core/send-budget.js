/**
 * Proactive-send budget. Jarvis talks to WhatsApp through an unofficial client, where
 * automated bulk sending risks a ban, so every PROACTIVE send (a scheduled message or a
 * broadcast) must draw from a budget before it goes out. Direct replies to a command are
 * solicited and are never throttled here.
 *
 * Two limits, applied to a PER-COMMAND key and to a shared GLOBAL key:
 *  - an even MIN-INTERVAL between sends, derived from the hourly rate (so output is spread
 *    out over time and never bursts), and
 *  - a rolling DAILY cap (a hard ceiling per 24h).
 * State is persisted in the KV store (ADR-0002) with an injected clock, so it survives a
 * restart - a crash can't reset the rate and re-burst - and is fully unit-testable.
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number, perCommand?: { perHour: number, perDay: number }, global?: { perHour: number, perDay: number } }} [opts]
 */
export function createSendBudget(store, {
  now = () => Date.now(),
  perCommand = { perHour: 60, perDay: 300 },
  global = { perHour: 120, perDay: 600 },
} = {}) {
  const slots = store.scoped('send-budget'); // key -> { last: ms, day: number[] }
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  // Clamp to positive integers so a missing or odd config can never divide by zero or
  // silently block all output (a zero/negative cap would make every send fail forever).
  const clamp = (c) => ({ perHour: Math.max(1, Math.floor(Number(c?.perHour) || 1)), perDay: Math.max(1, Math.floor(Number(c?.perDay) || 1)) });
  const limits = { cmd: clamp(perCommand), global: clamp(global) };
  const cfg = (key) => (key === 'global' ? limits.global : limits.cmd);
  const minInterval = (key) => Math.floor(HOUR / cfg(key).perHour);

  // -Infinity default means "never sent", so the first send is always allowed; it is only
  // in memory (a real timestamp is what gets stored), so it never reaches JSON.
  const read = (key, at) => {
    const s = slots.get(key);
    return { last: s?.last ?? -Infinity, day: (s?.day ?? []).filter((t) => at - t < DAY) };
  };
  const allows = (key, at) => {
    const s = read(key, at);
    return at - s.last >= minInterval(key) && s.day.length < cfg(key).perDay;
  };

  /** True if one more proactive send for `command` is allowed right now (command AND global). */
  function canSend(command, at = now()) {
    return allows(`cmd:${command}`, at) && allows('global', at);
  }

  /** Record one proactive send for `command`, against both the command and global budgets. */
  function record(command, at = now()) {
    for (const key of [`cmd:${command}`, 'global']) {
      const s = read(key, at);
      slots.set(key, { last: at, day: [...s.day, at] });
    }
  }

  return { canSend, record };
}
