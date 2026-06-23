import { b, i, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

/**
 * Owner: send an Instagram DM from WhatsApp (the outbound Instagram bridge; see `insta/`).
 * `jarvis ig <person> <message>` sends a DM to that Instagram username; `jarvis ig` shows the bridge
 * status (logged in? a login challenge pending? how many sent this hour); `jarvis ig code <value>`
 * answers a login challenge (2FA / checkpoint). Owner-only and needs the Instagram sidecar
 * configured; off it, the command reports unavailable. Outbound only - it does not receive DMs.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ig',
  summary: 'Owner: send an Instagram DM from here.',
  usage: 'jarvis ig | ig <person> <message> | ig code <value>',
  man:
    'Send Instagram DMs from WhatsApp (outbound only - it does not receive). "jarvis ig <person> ' +
    '<message>" sends a DM to that Instagram username; "jarvis ig" shows the bridge status (logged ' +
    'in, any pending login challenge, sends this hour); "jarvis ig code <value>" answers a login ' +
    'challenge (2FA / checkpoint). Owner-only; needs the Instagram sidecar configured.',
  scope: { owner: true },
  requires: ['instagram'],
  // Sending a DM is consequential, so the AI translator never auto-sends from a guess - it suggests
  // the exact line to type. Status and challenge-code are safe to auto-run. (Typing it yourself always
  // runs immediately - this only gates the AI path.)
  confirm: (args) => {
    const sub = (args[0] ?? '').toLowerCase();
    return !!sub && sub !== 'code';
  },
  params: [
    { name: 'person', desc: 'an Instagram username to DM, "code" to answer a login challenge, or omit to show bridge status' },
    { name: 'message', variadic: true, desc: 'the message to send (or the challenge code, after "code")' },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').trim();
    if (!sub) return status(ctx);

    if (sub.toLowerCase() === 'code') {
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
function sendError(person, r) {
  switch (r.reason) {
    case 'challenge_required':
      return `Instagram needs a login code first - type ${code('jarvis ig code <value>')}${r.detail ? ` (${esc(r.detail)})` : ''}.`;
    case 'not_logged_in':
    case 'login_failed':
      return `The Instagram bridge isn't logged in yet - check ${code('jarvis ig')}.`;
    case 'rate_capped':
      return 'Holding off to stay safe - the hourly send cap is reached. Try again later.';
    case 'unknown_user':
      return `Couldn't find Instagram user ${b(esc(person))}.`;
    case 'disabled':
      return 'The Instagram bridge is disabled (not configured).';
    default:
      return `Could not send to ${b(esc(person))} - the bridge may be offline.`;
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
  out.push(i('send with ') + code('jarvis ig <person> <message>'));
  return out.join('\n');
}
