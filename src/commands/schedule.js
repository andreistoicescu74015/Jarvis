import { b, i, code, bullet, esc } from '../core/format.js';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A timestamp as a readable server-local `YYYY-MM-DD HH:MM`. */
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A repeat interval in ms back to the shortest whole `<N>{d|h|m}`. */
function fmtEvery(ms) {
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`;
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  return `${ms / UNIT_MS.m}m`;
}

const describe = (j) =>
  j.repeatMs ? `every ${fmtEvery(j.repeatMs)}, next ${fmtTime(j.fireAt)}` : `at ${fmtTime(j.fireAt)}`;

const confirm = (r) =>
  r.repeatMs
    ? `Scheduled ${code(r.id)}: every ${fmtEvery(r.repeatMs)}, first at ${b(fmtTime(r.fireAt))}.`
    : `Scheduled ${code(r.id)} for ${b(fmtTime(r.fireAt))}.`;

const whenError = (r) =>
  r.reason === 'past'
    ? 'That time is already past.'
    : r.reason === 'empty-text'
      ? 'The message is empty.'
      : 'Bad time. Use "in 2h", "at 2026-06-18 09:00", or "every 1d" (units: m, h, d).';

/**
 * Schedule a message for the bot to post later - once or repeating - without an inbound
 * trigger (the opt-in proactive posting the design allows). A proactive command, so it is
 * group-only: usable in a group by an admin, and in a private chat only by the owner
 * (`scope.admin` + `scope.proactive`). Bound to this chat: a job fires here, and
 * `list`/`cancel` only see this chat's jobs. Parsing and persistence live in
 * `core/scheduler.js`; this command is a thin front for it.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'schedule',
  summary: 'Schedule a message to post later (once or repeating).',
  usage: 'jarvis schedule in <2h> <msg> | at <YYYY-MM-DD> <HH:MM> <msg> | every <1d> <msg> | list | cancel <id>',
  man:
    'Post a message to this chat later, with no one sending a command at that moment. ' +
    '"schedule in 2h <msg>" posts once in two hours; "schedule at 2026-06-18 09:00 <msg>" posts once at ' +
    'an absolute (server-local) time; "schedule every 1d <msg>" repeats. Durations are <number><unit> ' +
    'with unit m (minutes), h (hours) or d (days). "schedule list" shows this chat\'s scheduled messages ' +
    'with ids; "schedule cancel <id>" removes one. Scheduling works only in groups (where an admin can ' +
    'do it), not in private chats - the owner excepted. Schedules survive restarts.',
  scope: { admin: true, proactive: true },
  requires: ['scheduler'],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub || sub === 'list') {
      const jobs = ctx.scheduler.list();
      if (!jobs.length) return 'Nothing scheduled here.';
      return [b('Scheduled'), bullet(jobs.map((j) => `${code(j.id)}: ${i(describe(j))} -> "${esc(j.text)}"`))].join('\n');
    }

    if (sub === 'cancel') {
      const id = (ctx.args[1] ?? '').trim();
      if (!id) return `Usage: ${code('jarvis schedule cancel <id>')}`;
      return ctx.scheduler.cancel(id).ok ? `Cancelled ${code(id)}.` : `No scheduled message "${esc(id)}" here.`;
    }

    if (sub === 'in' || sub === 'every') {
      const spec = ctx.args[1];
      const text = ctx.args.slice(2).join(' ').trim();
      if (!spec || !text) return `Usage: ${code(`jarvis schedule ${sub} <${sub === 'every' ? '1d' : '2h'}> <message>`)}`;
      const r = ctx.scheduler.add(`${sub} ${spec}`, text);
      return r.ok ? confirm(r) : whenError(r);
    }

    if (sub === 'at') {
      const date = ctx.args[1];
      const time = ctx.args[2];
      const text = ctx.args.slice(3).join(' ').trim();
      if (!date || !time || !text) return `Usage: ${code('jarvis schedule at <YYYY-MM-DD> <HH:MM> <message>')}`;
      const r = ctx.scheduler.add(`at ${date} ${time}`, text);
      return r.ok ? confirm(r) : whenError(r);
    }

    return `Usage: ${code('jarvis schedule in <2h> <msg> | at <YYYY-MM-DD> <HH:MM> <msg> | every <1d> <msg> | list | cancel <id>')}`;
  },
};
