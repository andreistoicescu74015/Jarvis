import { b, i, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

// Action-first so the surface is unambiguous for both a person typing and the AI translator: the first
// word is always one of these verbs (a closed set the model picks from), then a target, then the text.
const ACTIONS = ['list', 'read', 'send', 'code'];

/**
 * Owner: use Instagram DMs from WhatsApp (the outbound + read-on-demand bridge; see the README).
 * See your conversations, pick one, read the last messages, and reply - by hand or in plain language:
 *   jarvis ig list                       - your recent conversations, numbered
 *   jarvis ig read <person|n> [count]     - the last messages of a 1:1 (username) or a thread (number)
 *   jarvis ig send <person|n> <message>   - send a message to a username or a numbered conversation
 *   jarvis ig                            - bridge status
 *   jarvis ig code <value>               - answer a login challenge (2FA / checkpoint)
 * Owner-only; needs the Instagram sidecar configured. With an AI provider set, the owner can also use
 * natural language ("read my chat with maria", "reply to maria: on my way") - it maps to these.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ig',
  summary: 'Owner: read and send Instagram DMs (and groups) from here.',
  usage: 'jarvis ig | ig list | ig read <person|n> [count] | ig send <person|n> <message> | ig code <value>',
  man:
    'Use Instagram DMs from WhatsApp (manual, read on demand). "jarvis ig list" shows your recent ' +
    'conversations with a number; "jarvis ig read <person|n> [count]" shows the last messages of a ' +
    'conversation (a username, or a number from the list - works for groups too); "jarvis ig send ' +
    '<person|n> <message>" sends a message to that username or numbered conversation; "jarvis ig" shows ' +
    'status; "jarvis ig code <value>" answers a login challenge. Owner-only; needs the Instagram sidecar. ' +
    'With an AI provider configured you can also phrase any of these in natural language.',
  scope: { owner: true },
  requires: ['instagram'],
  params: [
    { name: 'action', enum: ACTIONS, desc: 'what to do (omit to show status): "list" recent conversations, "read" a conversation, "send" a message, "code" to submit a login code' },
    { name: 'target', desc: 'an Instagram username, or a number from "jarvis ig list"; for "code" this is the verification code; for "list" omit it' },
    { name: 'message', variadic: true, desc: 'for "send", the message to send; for "read", how many recent messages to show (default 10)' },
  ],
  run: async (ctx) => {
    const action = (ctx.args[0] ?? '').toLowerCase();
    if (!action) return status(ctx);
    if (!ACTIONS.includes(action)) {
      return misuse(`Usage: ${code('jarvis ig list | ig read <person|n> | ig send <person|n> <message> | ig code <value>')}`);
    }
    if (action === 'list') return list(ctx);
    if (action === 'read') return read(ctx);
    if (action === 'send') return send(ctx);
    // action === 'code'
    const value = ctx.args.slice(1).join(' ').trim();
    if (!value) return misuse(`Usage: ${code('jarvis ig code <value>')}`);
    return (await ctx.instagram.code(value))
      ? 'Submitted the code to Instagram.'
      : `Could not submit the code - is a login challenge pending? Check ${code('jarvis ig')}.`;
  },
};

/** Resolve a read/send target: a number from the last `ig list` (a thread), or an Instagram username. */
function resolveTarget(ctx, raw) {
  const target = String(raw ?? '').trim();
  if (!target) return null;
  const n = Number(target);
  if (Number.isInteger(n)) {
    const recent = ctx.store?.get('ig-recent') ?? [];
    const t = recent.find((x) => x.n === n);
    return t ? { threadId: t.threadId, label: t.title } : { missing: n };
  }
  const username = target.replace(/^@/, '');
  return { username, label: username };
}

/** `ig read <person|n> [count]` - show the last messages of a conversation. */
async function read(ctx) {
  const resolved = resolveTarget(ctx, ctx.args[1]);
  if (!resolved) return misuse(`Usage: ${code('jarvis ig read <person|number> [count]')}`);
  if (resolved.missing) return `No conversation #${resolved.missing} here - run ${code('jarvis ig list')} first.`;
  const count = Number(ctx.args[2]) > 0 ? Math.min(Math.floor(Number(ctx.args[2])), 50) : 10;
  const res = await ctx.instagram.messages(
    resolved.threadId ? { threadId: resolved.threadId, amount: count } : { username: resolved.username, amount: count },
  );
  if (!res.ok) return readError(resolved.label, res);
  if (!res.messages.length) return 'No messages in that conversation yet.';
  const header = res.title || resolved.label;
  const lines = res.messages.map((m) => `${b(esc(m.fromMe ? 'me' : m.username || header))}: ${esc(m.text)}`);
  return [`${b(`IG - ${esc(header)}`)} ${i(`(last ${res.messages.length})`)}`, ...lines].join('\n');
}

/** `ig send <person|n> <message>` - send to a username or a numbered conversation. */
async function send(ctx) {
  const resolved = resolveTarget(ctx, ctx.args[1]);
  const message = ctx.args.slice(2).join(' ').trim();
  if (!resolved || !message) return misuse(`Usage: ${code('jarvis ig send <person|number> <message>')}`);
  if (resolved.missing) return `No conversation #${resolved.missing} here - run ${code('jarvis ig list')} first.`;
  const r = resolved.threadId
    ? await ctx.instagram.sendThread(resolved.threadId, message)
    : await ctx.instagram.send(resolved.username, message);
  return r.ok ? `Sent to ${b(esc(resolved.label))} on Instagram.` : sendError(resolved.label, r);
}

/** `ig list` - recent conversations, numbered, remembered so `read`/`send <n>` can target one. */
async function list(ctx) {
  const res = await ctx.instagram.threads();
  if (!res.ok || !res.threads.length) return 'No recent Instagram conversations (or the bridge is offline).';
  const remembered = res.threads.map((t, idx) => ({ n: idx + 1, threadId: t.threadId, title: t.title, isGroup: t.isGroup }));
  ctx.store?.set('ig-recent', remembered); // so `jarvis ig read <n>` / `send <n>` resolve the number
  const lines = remembered.map((t) => `${t.n}. ${esc(t.title)}${t.isGroup ? ` ${i('(group)')}` : ''}`);
  return [b('Instagram - recent conversations'), ...lines, i('read: ') + code('jarvis ig read <n>') + i(' , reply: ') + code('jarvis ig send <n> <message>')].join('\n');
}

/** Bridge status (connection, any pending challenge, sends this hour). */
async function status(ctx) {
  const s = await ctx.instagram.status();
  if (!s.ok || s.state === 'offline') return 'Instagram bridge: offline (the sidecar is not reachable).';
  const out = [b('Instagram bridge'), `State: ${esc(s.state)}${s.account ? ` (${esc(s.account)})` : ''}`];
  if (s.state === 'challenge_required') {
    out.push(`Needs a login code: ${code('jarvis ig code <value>')}${s.detail ? ` - ${esc(s.detail)}` : ''}`);
  }
  if (typeof s.sentLastHour === 'number') out.push(i(`${s.sentLastHour} sent in the last hour`));
  out.push(i('see your chats: ') + code('jarvis ig list'));
  return out.join('\n');
}

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
