/** Map a link failure reason to a clear message. */
function linkError(r) {
  return (
    {
      'bad-code': 'Unknown code.',
      expired: 'That code has expired - ask for a new one.',
      'already-linked': 'Already linked (unlink first).',
      'same-chat': 'A chat cannot link to itself.',
      conflict: `Conflicting data (${(r.conflicts ?? []).join(', ')}); clear one side, "adopt" instead, or try again.`,
    }[r.reason] ?? 'Could not link.'
  );
}

/**
 * Context links: link this chat with another so they share one context (data +
 * membership). Authority-gated by `scope.admin` - a group admin, or the user in a
 * private chat (owner status does not matter). The proposer runs `link new` for a
 * one-time code; the other chat's authority runs `link accept <code>` (merge, refuses
 * on conflict) or `link adopt <code>` (take the other context, set this chat's own data
 * aside until it unlinks). `link remove` leaves the link.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'link',
  summary: 'Link this chat with another to share one context.',
  usage: 'jarvis link | link new | link accept <code> | link adopt <code> | link remove',
  man:
    'Share one context (data + membership) between chats. In a group only an admin can link; in a ' +
    'private chat the user can. Run "link new" for a one-time code, share it with the other chat, and ' +
    'there an admin runs "link accept <code>" (merges the two, refusing if data conflicts) or ' +
    '"link adopt <code>" (takes the other chat\'s context; this chat\'s own data is set aside and ' +
    'returns on unlink). "link remove" leaves the link; "link" alone shows the status.',
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
      return `Linking code: ${code}\nShare it with the other chat; there an admin runs "jarvis link accept ${code}" (or "adopt ${code}"). It expires in 10 minutes.`;
    }
    if (sub === 'accept' || sub === 'adopt') {
      const code = ctx.args[1];
      if (!code) return `Usage: jarvis link ${sub} <code>`;
      const r = sub === 'adopt' ? ctx.links.adopt(code) : ctx.links.accept(code);
      if (!r.ok) return linkError(r);
      return sub === 'adopt'
        ? "Adopted - this chat now shares the other's context; its own data is set aside and returns when you unlink."
        : 'Linked - this chat now shares one context with the other.';
    }
    if (sub === 'remove') {
      const r = ctx.links.unlink();
      return r.ok ? 'Unlinked - this chat keeps a copy of the shared data.' : 'This chat is not linked.';
    }
    return 'Usage: jarvis link | link new | link accept <code> | link adopt <code> | link remove';
  },
};
