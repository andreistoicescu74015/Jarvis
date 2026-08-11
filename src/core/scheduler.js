/**
 * Scheduler: post a message later, once or on a repeating interval. This is the
 * bot's first proactive output - a chat's authority schedules a message and the bot
 * posts it with no inbound trigger (the opt-in proactive posting the design allows).
 *
 * Pure over the KV store (ADR-0002), like `links`/`access`: a job is one KV entry, so
 * schedules survive restarts and no SQL table is needed. The clock (`now`) is injected
 * and delivery is an injected callback (`deliver(chatId, text)`), so the core never
 * imports an adapter and the whole thing is unit-testable without a live connection.
 * A background runner (`startProactive`) drives `tick` on a timer; the platform paces the
 * actual sends (a single global spacing limiter), so proactive output never bursts.
 *
 * A job: `{ chatId, text, fireAt, repeatMs, createdBy, createdAt }` stored under its id.
 */

import * as chrono from 'chrono-node';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// Bounds so scheduled jobs cannot grow the store without limit (mirrors the note caps): a per-message
// length cap and a per-chat job count. Creating jobs is admin-gated, but a cap keeps a runaway or a
// careless loop from filling the disk.
const MAX_TEXT_LEN = 1000; // characters in one scheduled message
const MAX_JOBS = 100; // scheduled jobs kept per chat

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

// Words that signal a RECURRING intent. chrono parses one-shot times only, so we refuse these rather than
// silently scheduling a single occurrence (e.g. "water plants every 3 days" would otherwise become a
// one-shot with a dangling "every" left in the message). "every" is caught ANYWHERE in the line (it almost
// always means recurrence); the other frequency words only when they LEAD, so a one-shot that merely
// contains "daily"/"weekly" as an adjective ("send the daily report tomorrow") still goes through. The
// user is pointed back to the strict `every <N>{m|h|d}` form.
const RECURRENCE_RE = /\bevery\b|^(?:each|daily|weekly|monthly|hourly|annually|yearly)\b/i;

/**
 * Parse a FREE natural-language reminder into an absolute fire time AND the leftover message, using
 * chrono. One-shot only (no recurrence). Times are server-local; `now` is injected so parsing is
 * deterministic. Returns a reason on failure rather than throwing.
 *
 * @param {string} input  e.g. "call the dentist tomorrow at 9am"
 * @param {number} now    Current time in ms (injected).
 * @returns {{ ok: true, fireAt: number, message: string } | { ok: false, reason: 'no-nl-recurrence' | 'no-time' | 'past' | 'empty-text' }}
 */
export function parseNatural(input, now) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'empty-text' };
  if (RECURRENCE_RE.test(text)) return { ok: false, reason: 'no-nl-recurrence' };
  let results;
  try {
    results = chrono.parse(text, new Date(now), { forwardDate: true });
  } catch {
    return { ok: false, reason: 'no-time' };
  }
  if (!results.length) return { ok: false, reason: 'no-time' };
  const r = results[0];
  const fireAt = r.date().getTime();
  if (Number.isNaN(fireAt)) return { ok: false, reason: 'no-time' };
  if (fireAt <= now) return { ok: false, reason: 'past' };
  // chrono reports the exact span it matched, so the message is the text with that span removed.
  const message = (text.slice(0, r.index) + text.slice(r.index + r.text.length)).replace(/\s+/g, ' ').trim();
  if (!message) return { ok: false, reason: 'empty-text' };
  return { ok: true, fireAt, message };
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
  // Validate the message + per-chat bounds, then persist one job. Shared by `add` (a strict when-spec)
  // and `addNatural` (free natural language) so both enforce the same caps and store the same shape.
  function persist({ chatId, createdBy = '', text, fireAt, repeatMs, kind }) {
    if (!String(text ?? '').trim()) return { ok: false, reason: 'empty-text' };
    if (String(text).length > MAX_TEXT_LEN) return { ok: false, reason: 'too-long', max: MAX_TEXT_LEN };
    if (list(chatId).length >= MAX_JOBS) return { ok: false, reason: 'too-many', max: MAX_JOBS };
    const id = nextId();
    // `kind: 'ai'` marks a job whose `text` is an INSTRUCTION to run through the AI pipeline at fire
    // time, not a literal message. Stored only when set, so plain jobs keep their original shape.
    jobs.set(id, { chatId, text, fireAt, repeatMs, createdBy, createdAt: now(), ...(kind ? { kind } : {}) });
    return { ok: true, id, fireAt, repeatMs };
  }

  function add({ chatId, createdBy = '', when, text, kind }) {
    const w = parseWhen(when, now());
    if (!w.ok) return w;
    return persist({ chatId, createdBy, text, fireAt: w.fireAt, repeatMs: w.repeatMs, kind });
  }

  // Schedule from a FREE natural-language line ("call mom tomorrow at 9am"): chrono extracts the time
  // and the remainder becomes the message. One-shot only (recurrence stays on the strict `every` form).
  function addNatural({ chatId, createdBy = '', input, kind }) {
    const p = parseNatural(input, now());
    if (!p.ok) return p;
    return persist({ chatId, createdBy, text: p.message, fireAt: p.fireAt, repeatMs: 0, kind });
  }

  /** This chat's jobs, soonest first. */
  const list = (chatId) => all().filter((j) => j.chatId === chatId).sort((a, b) => a.fireAt - b.fireAt);

  /**
   * EVERY chat's jobs, soonest first - the owner's oversight view of all pending proactive output.
   * Per-chat `list` is what a chat's own admins see; this one answers "what will Jarvis post
   * anywhere", which is the question unattended sending actually raises. Read-only.
   */
  const listAll = () => all().sort((a, b) => a.fireAt - b.fireAt);

  /** Cancel a job, but only one that belongs to `chatId` (a chat can't cancel another's). */
  function cancel(id, chatId) {
    const j = jobs.get(id);
    if (!j || j.chatId !== chatId) return { ok: false, reason: 'not-found' };
    jobs.delete(id);
    return { ok: true };
  }

  /** Remove every job belonging to a chat (e.g. the bot was removed from that group). Returns the count. */
  function clearChat(chatId) {
    const mine = all().filter((j) => j.chatId === chatId);
    for (const j of mine) jobs.delete(j.id);
    return mine.length;
  }

  /** Pause (disabled=true) or resume one job, kept either way; a paused job is skipped by `tick`. */
  function setEnabled(id, chatId, enabled) {
    const j = jobs.get(id);
    if (!j || j.chatId !== chatId) return { ok: false, reason: 'not-found' };
    jobs.set(id, { ...j, disabled: !enabled });
    return { ok: true };
  }

  /** Pause or resume every job of a chat at once. Returns the count changed. */
  function setEnabledAll(chatId, enabled) {
    const mine = all().filter((j) => j.chatId === chatId);
    for (const j of mine) jobs.set(j.id, { ...j, disabled: !enabled });
    return mine.length;
  }

  /**
   * Fire every job due at `at`: deliver it, then reschedule a repeating job to its next
   * future slot (skipping any intervals missed while down) or drop a one-time job. A
   * delivery failure is swallowed and the job still advances - best-effort, never a retry
   * storm. The actual sends are paced downstream (the platform's global spacing limiter), so
   * the scheduler just fires everything due. Returns fired / failed.
   *
   * @param {(chatId: string, text: string, job: object) => unknown} deliver
   * @param {number} [at]
   * @returns {Promise<{ fired: number, failed: number }>}
   */
  async function tick(deliver, at = now()) {
    const due = all().filter((j) => j.fireAt <= at && !j.disabled).sort((a, b) => a.fireAt - b.fireAt);
    let fired = 0;
    let failed = 0;
    for (const j of due) {
      let declined = false;
      try {
        // `deliver` may DECLINE by returning false when the destination is currently
        // ineligible (e.g. an inactive group, or one the bot was removed from): neither a
        // success nor a failure. The job is left pending and untouched - never counted as
        // fired, never advanced or dropped (which would silently lose or zombie it) - so it
        // delivers later if the destination becomes eligible again.
        const r = await deliver(j.chatId, j.text, j);
        if (r === false) declined = true;
        else fired++;
      } catch {
        failed++;
      }
      if (declined) continue;
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

  return { add, addNatural, list, listAll, cancel, clearChat, setEnabled, setEnabledAll, tick };
}
