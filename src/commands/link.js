import { b, code, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

/** Map a link failure reason to a clear message. */
function linkError(r) {
  return (
    {
      'bad-code': 'Unknown code.',
      expired: 'That code has expired - ask for a new one.',
      'same-chat': 'A group cannot link to itself.',
      inactive: `Both groups must be active first (${code('jarvis groups activate')}).`,
      'both-linked': 'Both groups are already in a link - unlink one side first.',
    }[r.reason] ?? 'Could not link.'
  );
}

/**
 * Context links: join two GROUPS so they share one overlay context (DATA only - the shared notes).
 * The overlay COVERS each group's own data without merging it; unlinking returns each to its own.
 * Group-only and admin-gated (scope.admin): an admin in one group runs "link new" for a one-time code;
 * an admin in the other runs "link accept <code>". Both groups must be active. Access lists are never
 * shared - only data.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'link',
  summary: 'Link this group with another to share one context.',
  usage: 'jarvis link | link new | link accept <code> | link remove',
  man:
    'Lets two GROUPS share one set of notes. An admin on each side has to agree, and both groups must be active.\n' +
    `${code('jarvis link new')} here gives you a code that is good for ten minutes; an admin in the other group runs ${code('jarvis link accept <code>')}.\n` +
    `${code('jarvis link')} alone says whether this group is linked and to what.\n` +
    `${code('jarvis link remove')} leaves the link. Each group gets its own notes back - they were set aside, not merged, so nothing is lost.\n` +
    'A third group can join the same link. If one leaving would split the rest, the whole thing dissolves and the shared notes go with it.\n' +
    'Only data is shared. Who may use Jarvis in each group stays that group\'s business.',
  // admin-level, and group-only: linking is between groups, so it is refused in a private chat - and,
  // via `proactive`, hidden there from `help` and the AI tool catalog too (both filter by scope). The
  // owner bypasses scope and still reaches the body's clearer "only between groups" message.
  scope: { admin: true, proactive: true },
  requires: ['links'],
  // `remove` tears down the link and can dissolve the whole overlay (shared data discarded) -
  // destructive, so the AI translator never auto-runs it from a guess (the user must type it).
  confirm: (args) => (args[0] ?? '').toLowerCase() === 'remove',
  params: [
    { name: 'action', enum: ['new', 'accept', 'remove'], desc: 'create a link code, accept one, remove the link, or omit to show status' },
    { name: 'code', desc: 'the one-time link code (for accept)' },
  ],
  run: (ctx) => {
    if (ctx.level === 'private') return 'Linking works only between groups.';
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub) {
      const others = ctx.chats.filter((c) => c !== ctx.chatId);
      return others.length ? `${b('Linked with')}: ${others.map((c) => code(esc(c))).join(', ')}.` : 'Not linked.';
    }
    if (sub === 'new') {
      // The dispatcher's own activation rule (own entry OR community umbrella), via the ONE shared
      // predicate - so a group the bot demonstrably answers in can always start a link.
      if (!ctx.activation?.isActiveVia(ctx.chatId, ctx.communityId)) {
        return `Activate this group first (${code('jarvis groups activate')}).`;
      }
      const linkCode = ctx.links.propose();
      return `${b('Linking code')}: ${code(linkCode)}\nShare it with the other group; an admin there runs ${code('jarvis link accept ' + linkCode)}. It expires in 10 minutes.`;
    }
    if (sub === 'accept') {
      const linkCode = ctx.args[1];
      if (!linkCode) return misuse(`Usage: ${code('jarvis link accept <code>')}`);
      const r = ctx.links.accept(linkCode);
      if (!r.ok) return linkError(r);
      return r.redundant
        ? 'Added a redundant link - these were already linked (insurance against a split).'
        : 'Linked - this group now shares one context with the other.';
    }
    if (sub === 'remove') {
      const r = ctx.links.unlink();
      return r.ok ? 'Unlinked - this group is back to its own data.' : 'This group is not linked.';
    }
    return misuse(`Usage: ${code('jarvis link | link new | link accept <code> | link remove')}`);
  },
};
