import { b, code, esc, number } from '../core/format.js';

/**
 * Subscribe THIS chat to an RSS/Atom feed; Jarvis posts new entries on a periodic check (no AI). A
 * proactive command, so it is group-only: usable in a group by an admin, and in a private chat only by
 * the owner (`scope.admin` + `scope.proactive`), like `schedule`. Bound to this chat. Fetching and
 * parsing live in `core/feeds.js`; this command is a thin front for it.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'feed',
  summary: 'Subscribe this chat to an RSS/Atom feed; new entries are posted here.',
  usage: 'jarvis feed add <url> | list | remove <n>',
  man:
    'Subscribe this chat to an RSS or Atom feed: "feed add https://example.com/rss". Jarvis then posts ' +
    'new entries here on a periodic check, with no AI. The first check just notes what is already there, ' +
    'so you only get entries published AFTER you subscribe. "feed list" shows this chat\'s feeds with ' +
    'numbers; "feed remove <n>" unsubscribes one. Subscribing works only in groups (an admin can do it) ' +
    'or a private chat (the owner) - like scheduling.',
  scope: { admin: true, proactive: true },
  requires: ['feeds'],
  params: [
    { name: 'action', enum: ['add', 'list', 'remove'], required: true, desc: 'subscribe to a feed, list them, or remove one' },
    { name: 'rest', variadic: true, desc: 'for "add" the feed URL; for "remove" the number from "feed list"' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub || sub === 'list') {
      const feeds = ctx.feeds.list();
      if (!feeds.length) return 'No feeds here.';
      return [b('Feeds'), number(feeds.map((f) => esc(f.url)))].join('\n');
    }

    if (sub === 'add') {
      const url = (ctx.args[1] ?? '').trim();
      if (!url) return `Usage: ${code('jarvis feed add <url>')}`;
      const r = ctx.feeds.add(url);
      return r.ok
        ? "Subscribed - I'll post new entries from that feed here."
        : r.reason === 'bad-url'
          ? 'That does not look like an http(s) URL.'
          : `Too many feeds here (max ${r.max}); remove some first.`;
    }

    if (sub === 'remove') {
      const feeds = ctx.feeds.list();
      const n = Number(ctx.args[1]);
      const target = Number.isInteger(n) && n >= 1 ? feeds[n - 1] : undefined;
      if (!target) return `No feed #${esc(ctx.args[1] ?? '?')}. See ${code('jarvis feed list')}.`;
      ctx.feeds.remove(target.id);
      return `Removed feed ${code(esc(target.url))}.`;
    }

    return `Usage: ${code('jarvis feed add <url> | list | remove <n>')}`;
  },
};
