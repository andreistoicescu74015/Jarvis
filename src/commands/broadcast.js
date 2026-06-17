/**
 * Owner-only: send a private message to everyone in this context - every participant
 * of this chat and of every chat it is linked with (deduplicated, the bot skipped).
 * Sends are paced by the adapter. Needs the platform's participant + send capabilities;
 * off such a platform (e.g. the CLI) it reports as unavailable.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'broadcast',
  summary: 'Owner: DM a message to everyone in this context (and linked chats).',
  usage: 'jarvis broadcast <message>',
  man:
    'Send a private message to every participant of this chat and of every chat it is linked with ' +
    '(duplicates and the bot are skipped). Owner-only; sends are paced to stay within limits. ' +
    'Example: "jarvis broadcast Meeting moved to 5pm".',
  scope: { owner: true },
  run: async (ctx) => {
    if (!ctx.send || !ctx.participants) return 'Broadcast is unavailable here.';
    const message = ctx.rest.trim();
    if (!message) return 'Usage: jarvis broadcast <message>';

    const people = await ctx.participants();
    if (!people.length) return 'No one to send to.';
    for (const person of people) await ctx.send(person, message);
    return `Sent to ${people.length} ${people.length === 1 ? 'person' : 'people'}.`;
  },
};
