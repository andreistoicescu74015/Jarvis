import { b, i, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

/**
 * Owner: use Instagram DMs from WhatsApp (the outbound + read-on-demand bridge; see `insta/`).
 * Read a conversation, then reply - back and forth, without the Instagram app:
 *   jarvis ig read <person|n> [count]  - last messages of a 1:1 (by username) or a thread (by number)
 *   jarvis ig <person> <message>       - DM a username
 *   jarvis ig list                     - list recent threads (groups + DMs) with a number
 *   jarvis ig to <n> <message>         - send to thread number <n> (a group or a person)
 *   jarvis ig                          - bridge status
 *   jarvis ig code <value>             - answer a login challenge (2FA / checkpoint)
 * Owner-only; needs the Instagram sidecar configured. It does NOT receive DMs in the background -
 * reading is on demand.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ig',
  summary: 'Owner: read and send Instagram DMs (and groups) from here.',
  usage: 'jarvis ig | ig read <person|n> [count] | ig <person> <message> | ig list | ig to <n> <message> | ig code <value>',
  man:
    'Use Instagram DMs from WhatsApp - read on demand, then reply. "jarvis ig read <person> [count]" ' +
    'shows the last <count> messages of your 1:1 with that username (default 10); for a GROUP, "jarvis ' +
    'ig list" then "jarvis ig read <n> [count]". "jarvis ig <person> <message>" DMs a username; "jarvis ' +
    'ig to <n> <message>" sends to thread number <n> (a group or a person) from the last list. "jarvis ' +
    'ig" shows status; "jarvis ig code <value>" answers a login challenge. Owner-only; needs the ' +
    'Instagram sidecar configured. It does not receive DMs in the background - reading is on demand.',
  scope: { owner: true },
  requires: ['instagram'],
  // Sending is consequential, so the AI translator never auto-sends from a guess - it suggests the
  // exact line to type. Status / read / list / challenge-code are safe to auto-run. (Typing it yourself
  // always runs immediately - this only gates the AI path.)
  confirm: (args) => {
    const sub = (args[0] ?? '').toLowerCase();
    return !!sub && !['code', 'list', 'read'].includes(sub);
  },
  params: [
    { name: 'person', desc: 'an Instagram username to DM; or "read" (show a conversation), "list" (recent threads/groups), "to" (send to a thread number), "code" (answer a login challenge); omit to show status' },
    { name: 'message', variadic: true, desc: 'the message to send (or, after "read", a person/number then an optional count; after "to", the thread number then the message; after "code", the challenge code)' },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').trim();
    const subl = sub.toLowerCase();
    if (!sub) return status(ctx);
    if (subl === 'read') return read(ctx);
    if (subl === 'list') return list(ctx);
    if (subl === 'to' || subl === 't') return sendToThread(ctx);

    if (subl === 'code') {
      const value = ctx.args.slice(1).join(' ').trim();
      if (!value) return misuse(`Usage: ${code('jarvis ig code <value>')}`);
      return (await ctx.instagram.code(value))
        ? 'Submitted the code to Instagram.'
        : `Could not submit the code - is a login challenge pending? Check ${code('jarvis ig')}.`;
    }

    const message = ctx.args.slice(1).join(' ').trim();
    if (!message) return misuse(`Usage: ${code('jarvis ig <person> <message>')}`);
    const r = await ctx.instagram.send(sub, message);
    return r.ok ? `Sent to ${b(esc(sub))} on Instagram.` : sendError(sub, r);
  },
};

/** Map a failed send's reason to a clear, actionable line for the owner. */
function sendError(target, r) {
  switch (r.reason) {
    case 'challenge_required':
      return `Instagram needs a login code first - type ${code('jarvis ig code <value>')}${r.detail ? ` (${esc(r.detail)})` : ''}.`;
    case 'not_logged_in':
    case 'login_failed':
      return `The Instagram bridge isn't logged in yet - check ${code('jarvis ig')}.`;
    case 'rate_capped':
      return 'Holding off to stay safe - the hourly send cap is reached. Try again later.';
    case 'too_long':
      return 'That message is too long for an Instagram DM - shorten it.';
    case 'unknown_user':
      return `Couldn't find Instagram user ${b(esc(target))}.`;
    case 'disabled':
      return 'The Instagram bridge is disabled (not configured).';
    default:
      return `Could not send to ${b(esc(target))} - the bridge may be offline.`;
  }
}

/** Show the bridge status (connection, any pending challenge, sends this hour). */
async function status(ctx) {
  const s = await ctx.instagram.status();
  if (!s.ok || s.state === 'offline') return 'Instagram bridge: offline (the sidecar is not reachable).';
  const out = [b('Instagram bridge'), `State: ${esc(s.state)}${s.account ? ` (${esc(s.account)})` : ''}`];
  if (s.state === 'challenge_required') {
    out.push(`Needs a login code: ${code('jarvis ig code <value>')}${s.detail ? ` - ${esc(s.detail)}` : ''}`);
  }
  if (typeof s.sentLastHour === 'number') out.push(i(`${s.sentLastHour} sent in the last hour`));
  out.push(i('read with ') + code('jarvis ig read <person>') + i(' , send with ') + code('jarvis ig <person> <message>'));
  return out.join('\n');
}

/** Read the last few messages of a conversation - by username (1:1) or by a number from `ig list`. */
async function read(ctx) {
  const target = (ctx.args[1] ?? '').trim();
  if (!target) return misuse(`Usage: ${code('jarvis ig read <person|number> [count]')}`);
  const count = Number(ctx.args[2]) > 0 ? Math.min(Math.floor(Number(ctx.args[2])), 50) : 10;
  const recent = ctx.store?.get('ig-recent') ?? [];
  const n = Number(target);
  const byNumber = Number.isInteger(n) ? recent.find((t) => t.n === n) : undefined;
  const res = byNumber
    ? await ctx.instagram.messages({ threadId: byNumber.threadId, amount: count })
    : await ctx.instagram.messages({ username: target, amount: count });
  if (!res.ok) return readError(target, res);
  if (!res.messages.length) return 'No messages in that conversation yet.';
  const header = res.title || (byNumber ? byNumber.title || `thread #${n}` : target);
  const lines = res.messages.map((m) => `${b(esc(m.fromMe ? 'me' : m.username || header))}: ${esc(m.text)}`);
  return [`${b(`IG - ${esc(header)}`)} ${i(`(last ${res.messages.length})`)}`, ...lines].join('\n');
}

/** Map a failed read's reason to a clear line for the owner. */
function readError(target, r) {
  switch (r.reason) {
    case 'unknown_user':
      return `Couldn't find a conversation with ${b(esc(target))} - try ${code('jarvis ig list')} then ${code('jarvis ig read <number>')}.`;
    case 'challenge_required':
      return `Instagram needs a login code first - ${code('jarvis ig code <value>')}.`;
    case 'not_logged_in':
    case 'login_failed':
      return `The Instagram bridge isn't logged in - check ${code('jarvis ig')}.`;
    default:
      return 'Could not read that conversation - the bridge may be offline.';
  }
}

/** List recent DM + group threads, remembering number -> thread so `ig to <n>` / `ig read <n>` can target one. */
async function list(ctx) {
  const res = await ctx.instagram.threads();
  if (!res.ok || !res.threads.length) return 'No recent Instagram threads (or the bridge is offline).';
  const remembered = res.threads.map((t, idx) => ({ n: idx + 1, threadId: t.threadId, title: t.title, isGroup: t.isGroup }));
  ctx.store?.set('ig-recent', remembered); // so `jarvis ig to <n>` / `read <n>` resolve the number to a thread
  const lines = remembered.map((t) => `${t.n}. ${esc(t.title)}${t.isGroup ? ` ${i('(group)')}` : ''}`);
  return [b('Instagram - recent threads'), ...lines, i('read: ') + code('jarvis ig read <n>') + i(' , send: ') + code('jarvis ig to <n> <message>')].join('\n');
}

/** Send to a thread (group or 1:1) by its number from the last `jarvis ig list`. */
async function sendToThread(ctx) {
  const n = Number(ctx.args[1]);
  const message = ctx.args.slice(2).join(' ').trim();
  if (!Number.isInteger(n) || !message) {
    return misuse(`Usage: ${code('jarvis ig to <number> <message>')} (numbers from ${code('jarvis ig list')})`);
  }
  const recent = ctx.store?.get('ig-recent') ?? [];
  const target = recent.find((t) => t.n === n);
  if (!target) return `No thread #${n} here - run ${code('jarvis ig list')} first.`;
  const r = await ctx.instagram.sendThread(target.threadId, message);
  return r.ok ? `Sent to ${b(esc(target.title))} on Instagram.` : sendError(target.title, r);
}
