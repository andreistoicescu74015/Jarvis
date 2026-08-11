import { b, i, code, bullet, page, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const PAGE = 20; // jobs shown by one listing (the soonest); a chat may hold 100, which no message fits

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

const whenText = (r) =>
  r.reason === 'past'
    ? 'That time is already past.'
    : r.reason === 'empty-text'
      ? 'The message is empty.'
      : r.reason === 'no-time'
        ? 'I couldn\'t find a date or time in that. Try e.g. "tomorrow at 9am call mom", or "in 2h <msg>".'
        : r.reason === 'no-nl-recurrence'
          ? 'For a repeating message, use "every <N>{m|h|d}" - e.g. "every 1d <msg>".'
          : r.reason === 'too-long'
            ? `That message is too long (max ${r.max} characters).`
            : r.reason === 'too-many'
              ? `Too many scheduled messages here (max ${r.max}); cancel some first.`
              : 'Bad time. Use "in 2h", "at 2026-06-18 09:00", or "every 1d" (units: m, h, d).';

// A rejection with a specific, actionable cause is a plain answer - the caller already knows what to
// change. One that means "I could not read a time out of that" is a MIS-USAGE, so the dispatcher may
// add an AI "did you mean ...?" hint (never auto-run) on top of the usage text.
const CLEAR_CAUSE = new Set(['past', 'empty-text', 'no-nl-recurrence', 'too-long', 'too-many']);
const whenError = (r) => (CLEAR_CAUSE.has(r.reason) ? whenText(r) : misuse(whenText(r)));

/**
 * The owner's oversight view: every pending job, in every chat, soonest first. The per-chat `list` is
 * what a chat's own admins see; this one answers "what will Jarvis post anywhere", which is the
 * question unattended output actually raises. Chat names come from the platform's group list when it
 * can be reached; an unknown chat is shown by id. Owner-gated here, since the command itself is
 * admin-level.
 */
async function listEverywhere(ctx) {
  if (!ctx.isOwner) return "Only the owner can see every chat's schedule.";
  if (typeof ctx.scheduler.listAll !== 'function') return 'That view is unavailable here.';
  const all = ctx.scheduler.listAll();
  if (!all.length) return 'Nothing scheduled anywhere.';
  // Bound the whole view, not each chat's slice: the soonest jobs are the ones worth seeing, and a
  // bot in many chats would otherwise build a message no phone (and past a point, no message) holds.
  const { shown: jobs, hidden, total } = page(all, { limit: PAGE });
  const names = new Map();
  try {
    for (const g of (await ctx.listGroups?.()) ?? []) names.set(g.id, g.name);
  } catch {
    // A group-list failure costs only the names - the ids below are still the answer.
  }
  const byChat = new Map();
  for (const j of jobs) (byChat.get(j.chatId) ?? byChat.set(j.chatId, []).get(j.chatId)).push(j);
  const chats = new Set(all.map((j) => j.chatId)).size; // counted over ALL jobs, not the shown slice
  const out = [`${b('Scheduled everywhere')} ${i(`(${total} in ${chats} chat${chats === 1 ? '' : 's'})`)}`];
  for (const [chatId, chatJobs] of byChat) {
    const name = names.get(chatId);
    out.push(`${name ? `${b(esc(name))} ${code(esc(chatId))}` : code(esc(chatId))}:`);
    out.push(
      bullet(
        chatJobs.map(
          (j) =>
            `${code(j.id)}: ${i(describe(j))}${j.disabled ? ` ${i('(paused)')}` : ''}` +
            `${j.kind === 'ai' ? ` ${i('[ai]')}` : ''} -> "${esc(j.text)}"`,
        ),
      ),
    );
  }
  if (hidden) out.push(i(`Showing the ${jobs.length} soonest.`));
  return out.join('\n');
}

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
  usage: 'jarvis schedule <call mom tomorrow 9am> | in <2h> <msg> | at <YYYY-MM-DD> <HH:MM> <msg> | every <1d> <msg> | ai <when> <instruction> | list [all] | cancel <id|all> | disable|enable <id|all>',
  man:
    'Posts a message to this chat later, with nobody typing anything at that moment.\n' +
    `${code('jarvis schedule call mom tomorrow at 9am')} - written plainly, Jarvis finds the time and the rest is the message. One-off only.\n` +
    `Romanian works the same: ${code('jarvis schedule suna-l pe tata maine la 9')}, ${code('peste 2 ore')}, ${code('vineri la 10')}, ${code('diseara la 20')}.\n` +
    `${code('jarvis schedule in 2h <message>')} posts once, two hours from now.\n` +
    `${code('jarvis schedule at 2026-06-18 09:00 <message>')} posts once at that time (the server's clock).\n` +
    `${code('jarvis schedule every 1d <message>')} keeps repeating. Durations are a number and m, h or d.\n` +
    `${code('jarvis schedule list')} shows this chat's, each with an id. ${code('jarvis schedule cancel <id>')} drops one, ` +
    `${code('jarvis schedule clear')} drops them all.\n` +
    `${code('jarvis schedule disable <id>')} pauses one without losing it, ${code('enable')} starts it again. Both take ${code('all')}.\n` +
    `${code('jarvis schedule list all')} (owner) shows every chat at once, so you can see everything Jarvis is going to post anywhere.\n` +
    `${code('jarvis schedule ai every 1d summarize the notes here')} (owner) schedules an INSTRUCTION instead of fixed text: Jarvis works it out at that time and posts the answer.\n` +
    'Scheduling is for groups, by an admin; in a private chat only the owner can. Everything scheduled survives a restart.',
  scope: { admin: true, proactive: true },
  requires: ['scheduler'],
  // `clear` / `cancel all` delete every scheduled message here - destructive, so the AI translator
  // never auto-runs them from a guess (the user must type them); scheduling a new one is fine.
  confirm: (args) => {
    const sub = (args[0] ?? '').toLowerCase();
    return sub === 'clear' || (sub === 'cancel' && (args[1] ?? '').toLowerCase() === 'all');
  },
  params: [
    { name: 'action', enum: ['in', 'at', 'every', 'ai', 'list', 'cancel', 'clear', 'disable', 'enable'], required: true, desc: 'in/at/every to schedule a message; ai to schedule an AI instruction (owner); list/cancel/clear/disable/enable to manage' },
    { name: 'rest', variadic: true, desc: 'the remainder: for "in"/"every" it is "<duration> <message>" (e.g. "2h call mom", units m/h/d); for "at" it is "<YYYY-MM-DD> <HH:MM> <message>"; for cancel/disable/enable it is the id or "all"; for "list" it may be "all" (owner: every chat)' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub || sub === 'list') {
      // `schedule list all` - the owner's oversight view across EVERY chat. Only under the explicit
      // `list` verb: a bare `schedule all ...` would shadow a natural-language reminder that happens
      // to start with "all" ("all hands meeting tomorrow at 9").
      if ((ctx.args[1] ?? '').toLowerCase() === 'all') return listEverywhere(ctx);
      const jobs = ctx.scheduler.list();
      if (!jobs.length) return 'Nothing scheduled here.';
      const { shown, hidden, total } = page(jobs, { limit: PAGE }); // soonest first: the head is what matters
      const out = [
        b('Scheduled'),
        bullet(shown.map((j) => `${code(j.id)}: ${i(describe(j))}${j.disabled ? ` ${i('(paused)')}` : ''} -> "${esc(j.text)}"`)),
      ];
      if (hidden) out.push(i(`Showing the ${shown.length} soonest of ${total}.`));
      return out.join('\n');
    }

    if (sub === 'disable' || sub === 'enable') {
      const on = sub === 'enable';
      const id = (ctx.args[1] ?? '').trim();
      if (!id) return misuse(`Usage: ${code(`jarvis schedule ${sub} <id|all>`)}`);
      if (id.toLowerCase() === 'all') {
        const n = ctx.scheduler.setEnabledAll(on);
        return n ? `${on ? 'Resumed' : 'Paused'} all ${n} scheduled messages here.` : 'Nothing scheduled here.';
      }
      return ctx.scheduler.setEnabled(id, on).ok
        ? `${on ? 'Resumed' : 'Paused'} ${code(id)}.`
        : `No scheduled message "${esc(id)}" here.`;
    }

    if (sub === 'cancel' || sub === 'clear') {
      const id = (ctx.args[1] ?? '').trim();
      if (sub === 'clear' || id.toLowerCase() === 'all') {
        const n = ctx.scheduler.clear();
        return n ? `Cancelled all ${n} scheduled messages here.` : 'Nothing scheduled here.';
      }
      if (!id) return misuse(`Usage: ${code('jarvis schedule cancel <id|all>')}`);
      return ctx.scheduler.cancel(id).ok ? `Cancelled ${code(id)}.` : `No scheduled message "${esc(id)}" here.`;
    }

    if (sub === 'ai') {
      // Owner-only: schedule a natural-language INSTRUCTION that Jarvis runs through its AI pipeline at
      // fire time (it may run commands and/or compose a reply), not a fixed message. The when-spec is the
      // same in/at/every; the remainder is the instruction.
      if (!ctx.isOwner) return 'Only the owner can schedule an AI action.';
      const spec = (ctx.args[1] ?? '').toLowerCase();
      let when;
      let prompt;
      if (spec === 'in' || spec === 'every') {
        const dur = ctx.args[2];
        prompt = ctx.args.slice(3).join(' ').trim();
        if (!dur || !prompt) return misuse(`Usage: ${code(`jarvis schedule ai ${spec} <${spec === 'every' ? '1d' : '2h'}> <instruction>`)}`);
        when = `${spec} ${dur}`;
      } else if (spec === 'at') {
        const date = ctx.args[2];
        const time = ctx.args[3];
        prompt = ctx.args.slice(4).join(' ').trim();
        if (!date || !time || !prompt) return misuse(`Usage: ${code('jarvis schedule ai at <YYYY-MM-DD> <HH:MM> <instruction>')}`);
        when = `at ${date} ${time}`;
      } else {
        return misuse(`Usage: ${code('jarvis schedule ai in <2h> <instruction> | at <YYYY-MM-DD> <HH:MM> <instruction> | every <1d> <instruction>')}`);
      }
      const r = ctx.scheduler.add(when, prompt, 'ai');
      return r.ok ? confirm(r) : whenError(r);
    }

    if (sub === 'in' || sub === 'every') {
      const spec = ctx.args[1];
      const text = ctx.args.slice(2).join(' ').trim();
      if (!spec || !text) return misuse(`Usage: ${code(`jarvis schedule ${sub} <${sub === 'every' ? '1d' : '2h'}> <message>`)}`);
      const r = ctx.scheduler.add(`${sub} ${spec}`, text);
      return r.ok ? confirm(r) : whenError(r);
    }

    if (sub === 'at') {
      const date = ctx.args[1];
      const time = ctx.args[2];
      const text = ctx.args.slice(3).join(' ').trim();
      if (!date || !time || !text) return misuse(`Usage: ${code('jarvis schedule at <YYYY-MM-DD> <HH:MM> <message>')}`);
      const r = ctx.scheduler.add(`at ${date} ${time}`, text);
      return r.ok ? confirm(r) : whenError(r);
    }

    // The first word was not a known sub-action: treat the whole line as a free natural-language
    // reminder ("call mom tomorrow at 9am"). Deterministic (chrono), no AI - the typed convenience
    // form. A failure (no time found, recurrence, ...) returns a targeted hint via whenError.
    const nl = ctx.scheduler.addNatural(ctx.rest);
    return nl.ok ? confirm(nl) : whenError(nl);
  },
};
