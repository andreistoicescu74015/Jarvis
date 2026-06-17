/**
 * Scheduler: post a message later, once or on a repeating interval. This is the
 * bot's first proactive output - a chat's authority schedules a message and the bot
 * posts it with no inbound trigger (the opt-in proactive posting the design allows).
 *
 * Pure over the KV store (ADR-0002), like `links`/`access`: a job is one KV entry, so
 * schedules survive restarts and no SQL table is needed. The clock (`now`) is injected
 * and delivery is an injected callback (`deliver(chatId, text)`), so the core never
 * imports an adapter and the whole thing is unit-testable without a live connection.
 * A background runner (`startProactive`) drives `tick` on a timer; an optional send
 * budget paces deliveries so proactive output never bursts.
 *
 * A job: `{ chatId, text, fireAt, repeatMs, createdBy, createdAt }` stored under its id.
 */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a human "when" spec into an absolute fire time (and a repeat interval for
 * `every`). Times are server-local. Returns a reason on failure rather than throwing.
 *
 * Accepts: `in <N>{m|h|d}`, `every <N>{m|h|d}`, `at <YYYY-MM-DD> <HH:MM>`.
 *
 * @param {string} input
 * @param {number} now  Current time in ms (injected, so parsing is deterministic).
 * @returns {{ ok: true, fireAt: number, repeatMs: number } | { ok: false, reason: 'bad-when' | 'past' }}
 */
export function parseWhen(input, now) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^in (\d+)([mhd])$/))) {
    const ms = Number(m[1]) * UNIT_MS[m[2]];
    return ms > 0 ? { ok: true, fireAt: now + ms, repeatMs: 0 } : { ok: false, reason: 'bad-when' };
  }
  if ((m = s.match(/^every (\d+)([mhd])$/))) {
    const ms = Number(m[1]) * UNIT_MS[m[2]];
    return ms > 0 ? { ok: true, fireAt: now + ms, repeatMs: ms } : { ok: false, reason: 'bad-when' };
  }
  if ((m = s.match(/^at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/))) {
    const [, date, time] = m;
    const d = new Date(`${date}T${time}`); // server-local time
    const t = d.getTime();
    if (Number.isNaN(t)) return { ok: false, reason: 'bad-when' };
    // JS rolls an impossible date forward (2026-06-31 -> Jul 1) instead of failing, so
    // require the parsed date to print back exactly as typed - otherwise reject it.
    const p = (n) => String(n).padStart(2, '0');
    const back = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    if (back !== `${date} ${time}`) return { ok: false, reason: 'bad-when' };
    return t > now ? { ok: true, fireAt: t, repeatMs: 0 } : { ok: false, reason: 'past' };
  }
  return { ok: false, reason: 'bad-when' };
}

/**
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]
 */
export function createScheduler(store, { now = () => Date.now() } = {}) {
  const jobs = store.scoped('schedules'); // id -> job; plus '#seq' -> counter
  const SEQ = '#seq';

  const nextId = () => {
    const n = Number(jobs.get(SEQ) ?? 0) + 1;
    jobs.set(SEQ, n);
    return `s${n}`;
  };

  /** Every job as `{ id, ...record }` (the `#seq` counter is not a job). */
  const all = () => jobs.list().filter((e) => e.key !== SEQ).map((e) => ({ id: e.key, ...e.value }));

  /**
   * Schedule a message for `chatId`. Returns the new job's id and fire time, or a
   * reason the spec was rejected.
   *
   * @returns {{ ok: true, id: string, fireAt: number, repeatMs: number } | { ok: false, reason: string }}
   */
  function add({ chatId, createdBy = '', when, text }) {
    const w = parseWhen(when, now());
    if (!w.ok) return w;
    if (!String(text ?? '').trim()) return { ok: false, reason: 'bad-when' };
    const id = nextId();
    jobs.set(id, { chatId, text, fireAt: w.fireAt, repeatMs: w.repeatMs, createdBy, createdAt: now() });
    return { ok: true, id, fireAt: w.fireAt, repeatMs: w.repeatMs };
  }

  /** This chat's jobs, soonest first. */
  const list = (chatId) => all().filter((j) => j.chatId === chatId).sort((a, b) => a.fireAt - b.fireAt);

  /** Cancel a job, but only one that belongs to `chatId` (a chat can't cancel another's). */
  function cancel(id, chatId) {
    const j = jobs.get(id);
    if (!j || j.chatId !== chatId) return { ok: false, reason: 'not-found' };
    jobs.delete(id);
    return { ok: true };
  }

  /**
   * Fire every job due at `at`: deliver it, then reschedule a repeating job to its next
   * future slot (skipping any intervals missed while down) or drop a one-time job. A
   * delivery failure is swallowed and the job still advances - best-effort, never a
   * retry storm. With a `budget`, each delivery is gated and recorded; when the budget is
   * spent the remaining due jobs simply wait for the next window. Returns fired / failed.
   *
   * @param {(chatId: string, text: string) => unknown} deliver
   * @param {number} [at]
   * @param {{ canSend: (cmd: string, at: number) => boolean, record: (cmd: string, at: number) => void } | null} [budget]
   * @returns {Promise<{ fired: number, failed: number }>}
   */
  async function tick(deliver, at = now(), budget = null) {
    const due = all().filter((j) => j.fireAt <= at).sort((a, b) => a.fireAt - b.fireAt);
    let fired = 0;
    let failed = 0;
    for (const j of due) {
      if (budget && !budget.canSend('schedule', at)) break; // budget spent; the rest wait
      if (budget) budget.record('schedule', at);
      try {
        await deliver(j.chatId, j.text);
        fired++;
      } catch {
        failed++;
      }
      // Re-read after delivery: the store is shared with the message handler, so an
      // inbound `schedule cancel` can land during the await. Respect it - never write
      // a stale snapshot back (which would resurrect a job the user just cancelled).
      const cur = jobs.get(j.id);
      if (!cur) continue;
      if (cur.repeatMs > 0) {
        let next = cur.fireAt + cur.repeatMs;
        while (next <= at) next += cur.repeatMs;
        jobs.set(j.id, { ...cur, fireAt: next });
      } else {
        jobs.delete(j.id);
      }
    }
    return { fired, failed };
  }

  return { add, list, cancel, tick };
}
