import { b, i, bullet } from '../core/format.js';
import { accessContextFor } from '../core/access.js';

/**
 * One answer to "how is Jarvis set up here". Every line of it can already be had from `groups`,
 * `whitelist`, `ai`, `schedule`, `rule`, `note` and `link` - which is exactly the point: seven
 * commands to learn the state of one chat is six too many for someone managing several. Read-only,
 * and each line is skipped when the capability behind it is not wired, so it degrades instead of
 * lying. Admin-level, like the access lists: whoever manages the chat sees how it is set up.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'status',
  summary: 'Show how Jarvis is set up in this chat.',
  usage: 'jarvis status',
  man:
    'Sums up this chat in one answer: whether Jarvis is switched on here, who may use it, whether it ' +
    'also answers general questions, how much it is holding for you, and whether the chat shares its ' +
    'notes with another group.\n' +
    'Everything here can also be had one piece at a time from the commands that manage each thing.\n' +
    'It only reads; nothing changes.',
  scope: { ownerOrAdmin: true },
  run: (ctx) => {
    const lines = [];

    // Switched on here? Private chats are never gated, so the question does not apply there.
    if (ctx.activation && ctx.level !== 'private') {
      const own = ctx.activation.isActive(ctx.chatId);
      const via = !own && ctx.activation.isActiveVia(ctx.chatId, ctx.communityId);
      lines.push(`Jarvis is ${b(own ? 'on here' : via ? 'on, through its community' : 'off here')}`);
    }

    const who = audience(ctx);
    if (who) lines.push(`Who may use me: ${b(who)}`);

    if (ctx.aiGate) {
      const on = ctx.aiGate.isOn();
      const missing = ctx.aiGate.available ? '' : ` ${i('(no AI provider configured)')}`;
      lines.push(`General questions: ${b(on ? 'answered' : 'not answered')}${missing}`);
    }

    const held = holdings(ctx);
    if (held.length) lines.push(`Holding: ${held.join(', ')}`);

    // A linked group reads and writes the notes of the whole link, which is worth knowing here.
    const others = (ctx.chats ?? []).filter((c) => c !== ctx.chatId);
    if (others.length) lines.push(`Sharing notes with ${b(String(others.length))} other ${others.length === 1 ? 'group' : 'groups'}`);

    // Off a platform with any of this wired (a bare dispatcher), say so rather than print a heading
    // over nothing.
    if (!lines.length) return 'Nothing to report about this chat.';
    return [b('Status'), bullet(lines)].join('\n');
  },
};

/** Who the bot-wide list lets in here, in words. Admins always pass, so they are named where they matter. */
function audience(ctx) {
  if (!ctx.access) return undefined;
  const rec = ctx.access.get('*', accessContextFor(ctx.level, ctx.chatId));
  const alsoAdmins = ctx.level === 'private' ? '' : ', plus admins'; // a private chat has no admins
  if (rec.active === 'whitelist') {
    if (rec.whitelist.includes('*')) return 'everyone';
    const n = rec.whitelist.length;
    if (!n) return ctx.level === 'private' ? 'only me' : 'admins only';
    return `${n} listed ${n === 1 ? 'person' : 'people'}${alsoAdmins}`;
  }
  if (rec.active === 'blacklist') {
    if (rec.blacklist.includes('*')) return ctx.level === 'private' ? 'only me' : 'admins only';
    const n = rec.blacklist.length;
    return n ? `everyone except ${n}` : 'everyone';
  }
  return 'everyone';
}

/** What this chat has accumulated: notes, pending messages, auto-replies. Only what is actually there. */
function holdings(ctx) {
  // Wired-but-empty is "nothing yet"; nothing wired at all is not a claim worth making.
  if (!ctx.store && !ctx.scheduler && !ctx.rules) return [];
  const out = [];
  // Notes belong to the `note` command; read defensively so a change to its storage degrades to 0
  // here rather than throwing, and so the shape it used before stable ids still counts.
  const notes = ctx.store?.get('notes');
  const noteCount = Array.isArray(notes) ? notes.length : Array.isArray(notes?.items) ? notes.items.length : 0;
  if (noteCount) out.push(`${b(String(noteCount))} ${noteCount === 1 ? 'note' : 'notes'}`);

  const jobs = ctx.scheduler ? ctx.scheduler.list() : [];
  if (jobs.length) {
    const paused = jobs.filter((j) => j.disabled).length;
    out.push(`${b(String(jobs.length))} scheduled${paused ? ` ${i(`(${paused} paused)`)}` : ''}`);
  }

  const rules = ctx.rules ? ctx.rules.list() : [];
  if (rules.length) out.push(`${b(String(rules.length))} auto-${rules.length === 1 ? 'reply' : 'replies'}`);

  return out.length ? out : [i('nothing yet')];
}
