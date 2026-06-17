/**
 * Context links: link this chat with another so they share one context (data +
 * membership). Authority-gated by `scope.admin` - a group admin, or the user in a
 * private chat (owner status does not matter). The proposer runs `link new` for a
 * one-time code; the other chat's authority runs `link accept <code>`. Merging
 * refuses on conflicting data; `link remove` leaves, keeping a copy.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'link',
  summary: 'Link this chat with another to share one context.',
  usage: 'jarvis link | link new | link accept <code> | link remove',
  man:
    'Share one context (data + membership) between chats. In a group only an admin can link; in a ' +
    'private chat the user can. Run "link new" for a one-time code, share it with the other chat, and ' +
    'there an admin runs "link accept <code>". Linking merges data and refuses if it conflicts; ' +
    '"link remove" leaves the link (keeping a copy of the shared data); "link" alone shows the status.',
  scope: { admin: true },
  run: (ctx) => {
    if (!ctx.links) return 'Links are unavailable here.';
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub) {
      const others = ctx.chats.filter((c) => c !== ctx.chatId);
      return others.length ? `Linked with: ${others.join(', ')}.` : 'Not linked.';
    }
    if (sub === 'new') {
      const code = ctx.links.propose();
      return `Linking code: ${code}\nShare it with the other chat; there an admin runs "jarvis link accept ${code}". It expires in 10 minutes.`;
    }
    if (sub === 'accept') {
      const code = ctx.args[1];
      if (!code) return 'Usage: jarvis link accept <code>';
      const r = ctx.links.accept(code);
      if (r.ok) return 'Linked - this chat now shares one context with the other.';
      const why = {
        'bad-code': 'Unknown code.',
        expired: 'That code has expired - ask for a new one.',
        'already-linked': 'These chats are already linked.',
        'same-chat': 'A chat cannot link to itself.',
        conflict: `Conflicting data (${(r.conflicts ?? []).join(', ')}); clear one side and try again.`,
      };
      return why[r.reason] ?? 'Could not link.';
    }
    if (sub === 'remove') {
      const r = ctx.links.unlink();
      return r.ok ? 'Unlinked - this chat keeps a copy of the shared data.' : 'This chat is not linked.';
    }
    return 'Usage: jarvis link | link new | link accept <code> | link remove';
  },
};
