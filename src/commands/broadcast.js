/**
 * Owner-only: send a private message to everyone in this context - every participant of
 * this chat and of every chat it is linked with (deduplicated, the bot skipped). The
 * recipients are QUEUED, not blasted: the bot releases them gradually within its send
 * budget, so a large broadcast spreads out over time and never bursts (ban-safety on an
 * unofficial client). Needs the platform's participant capability and a send outbox; off
 * such a platform it reports as unavailable.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'broadcast',
  summary: 'Owner: DM a message to everyone in this context (and linked chats).',
  usage: 'jarvis broadcast <message>',
  man:
    'Send a private message to every participant of this chat and of every chat it is linked with ' +
    '(duplicates and the bot are skipped). Owner-only. The messages are queued and delivered gradually ' +
    'to stay within send limits, so a big broadcast is spread out over time. ' +
    'Example: "jarvis broadcast Meeting moved to 5pm".',
  scope: { owner: true },
  run: async (ctx) => {
    if (!ctx.enqueue || !ctx.participants) return 'Broadcast is unavailable here.';
    const message = ctx.rest.trim();
    if (!message) return 'Usage: jarvis broadcast <message>';

    const people = await ctx.participants();
    if (!people.length) return 'No one to send to.';
    ctx.enqueue('broadcast', people.map((chatId) => ({ chatId, text: message })));
    return `Queued broadcast to ${people.length} ${people.length === 1 ? 'person' : 'people'} - sending gradually to stay within limits.`;
  },
};
