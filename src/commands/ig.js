import { b, i, code, esc, bullet } from '../core/format.js';
import { misuse } from '../core/reply.js';

/**
 * Owner: read and answer your Instagram DMs from WhatsApp (the Instagram bridge; see `insta/`).
 * `jarvis ig` lists your recent threads; `jarvis ig <person> <message>` sends a DM; `jarvis ig code
 * <value>` answers an Instagram login challenge (2FA / checkpoint) the bridge relayed to you.
 * Incoming DMs arrive automatically as "[IG] <person>: ...". Owner-only and needs the Instagram
 * sidecar configured; off it, the command reports unavailable.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'ig',
  summary: 'Owner: read and reply to your Instagram DMs from here.',
  usage: 'jarvis ig | ig <person> <message> | ig code <value>',
  man:
    'Bridge your Instagram DMs into WhatsApp. "jarvis ig" lists recent threads; "jarvis ig <person> ' +
    '<message>" sends a DM to that Instagram username; "jarvis ig code <value>" answers a login ' +
    'challenge (2FA / checkpoint) the bridge asked you about. Incoming DMs are pushed to you ' +
    'automatically as "[IG] <person>: ...". Owner-only; needs the Instagram sidecar configured.',
  scope: { owner: true },
  requires: ['instagram'],
  // Sending a DM to a person is consequential, so the AI translator never auto-sends it from a guess -
  // it suggests the exact line to type. Listing threads and submitting a challenge code are safe to
  // auto-run. (Typing the command yourself always runs immediately - this only gates the AI path.)
  confirm: (args) => {
    const sub = (args[0] ?? '').toLowerCase();
    return !!sub && sub !== 'code';
  },
  params: [
    { name: 'person', desc: 'an Instagram username to DM, "code" to answer a login challenge, or omit to list recent threads' },
    { name: 'message', variadic: true, desc: 'the message to send (or the challenge code, after "code")' },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').trim();
    if (!sub) return list(ctx);

    if (sub.toLowerCase() === 'code') {
      const value = ctx.args.slice(1).join(' ').trim();
      if (!value) return misuse(`Usage: ${code('jarvis ig code <value>')}`);
      return (await ctx.instagram.code(value))
        ? 'Submitted the code to Instagram.'
        : 'Could not submit the code (is a login challenge pending?).';
    }

    const message = ctx.args.slice(1).join(' ').trim();
    if (!message) return misuse(`Usage: ${code('jarvis ig <person> <message>')}`);
    return (await ctx.instagram.send(sub, message))
      ? `Sent to ${b(esc(sub))} on Instagram.`
      : `Could not send to ${b(esc(sub))} - the Instagram bridge may be offline.`;
  },
};

/** List recent Instagram DM threads (best-effort; empty when the bridge is offline). */
async function list(ctx) {
  const threads = await ctx.instagram.threads();
  if (!threads.length) return 'No recent Instagram threads (or the bridge is offline).';
  return [
    b('Instagram - recent threads'),
    bullet(
      threads.map((t) => {
        const unread = t.unread ? ` ${i('(unread)')}` : '';
        const preview = t.lastText ? `: ${esc(t.lastText)}` : '';
        return `${esc(t.name || t.username)}${unread}${preview} ${code(`jarvis ig ${t.username} <message>`)}`;
      }),
    ),
  ].join('\n');
}
