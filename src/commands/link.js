import { b, code, esc } from '../core/format.js';

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
    'Share one overlay context (DATA: the notes) between two GROUPS. Both must be active, and ' +
    'an admin on each side agrees: run "link new" here for a one-time code, share it, and an admin in ' +
    'the other group runs "link accept <code>". The overlay covers each group\'s own data without ' +
    'merging it - unlinking returns each group to its own data. Links are transitive (a third group ' +
    'can join); a link between two already-linked groups is just insurance. "link remove" leaves the ' +
    'link; if that disconnects the rest, the whole overlay dissolves and every group reverts to its ' +
    'own data. Access lists are NOT shared - only data. "link" alone shows the status.',
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
      if (!ctx.activation?.isActive(ctx.chatId)) return `Activate this group first (${code('jarvis groups activate')}).`;
      const linkCode = ctx.links.propose();
      return `${b('Linking code')}: ${code(linkCode)}\nShare it with the other group; an admin there runs ${code('jarvis link accept ' + linkCode)}. It expires in 10 minutes.`;
    }
    if (sub === 'accept') {
      const linkCode = ctx.args[1];
      if (!linkCode) return `Usage: ${code('jarvis link accept <code>')}`;
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
    return `Usage: ${code('jarvis link | link new | link accept <code> | link remove')}`;
  },
};
