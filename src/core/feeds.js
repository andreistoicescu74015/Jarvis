/**
 * Feed digests: subscribe a chat to an RSS/Atom feed; a periodic check posts the NEW entries since the
 * last check (deterministic, no AI). OUTBOUND-ONLY - Jarvis fetches the feed URL and posts; it never
 * reads ambient chat (the addressed-only pillar holds). Pure over the KV store (ADR-0002) like
 * scheduler/access - one subscription is one KV entry, so feeds survive restarts. The fetch impl and
 * clock are injected, so parsing and the check loop are unit-testable offline.
 *
 * RSS/Atom parsing is minimal and best-effort: an unparseable or empty feed yields no items and never
 * throws, so a bad feed can never crash the bot.
 *
 * A subscription: `{ chatId, url, seen, checked, addedAt }` under its id. `seen` is a bounded list of
 * recent item ids already delivered (so each entry posts once); `checked` flags that the first
 * (baseline) fetch has run, so we only post entries published AFTER subscribing.
 */

const MAX_FEEDS = 20; // subscriptions kept per chat
const MAX_SEEN = 200; // remembered item ids per feed (bounds storage; older ids fall off)
const MAX_ITEMS_PER_CHECK = 5; // new items posted per feed per check (no burst from a busy feed)
const MAX_BODY = 2_000_000; // characters of a feed response we parse (a sanity cap)

const stripCdata = (s) => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
const fromCodePoint = (cp) => (Number.isInteger(cp) && cp >= 1 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '');
const decode = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16))) // hex entity, e.g. &#xe9;
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(Number(d))) // decimal entity, e.g. &#233;
    .replace(/&amp;/g, '&') // last, so &amp;#39; doesn't double-decode
    .trim();
const tagText = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(stripCdata(m[1])) : '';
};

/**
 * Parse an RSS or Atom document into items `{ id, title, link }`, in the order the feed lists them.
 * Tolerant and best-effort: returns [] for anything it cannot read.
 *
 * @param {string} xml
 * @returns {{ id: string, title: string, link: string }[]}
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  if (!text) return [];
  const items = [];
  for (const block of text.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? []) {
    const title = tagText(block, 'title');
    let link = tagText(block, 'link'); // RSS: <link>url</link>
    if (!link) {
      // Atom: an entry can carry several <link>s; prefer rel="alternate" (the article), else one with no
      // rel, else the first - so we never post the feed's own rel="self" URL instead of the article.
      const tags = block.match(/<link\b[^>]*>/gi) ?? [];
      const pick = tags.find((t) => /\brel=["']?alternate\b/i.test(t)) ?? tags.find((t) => !/\brel=/i.test(t)) ?? tags[0];
      const href = pick?.match(/\bhref=["']([^"']+)["']/i);
      link = href ? decode(href[1]) : '';
    }
    const id = tagText(block, 'guid') || tagText(block, 'id') || link || title;
    if (id) items.push({ id, title: title || link || id, link });
  }
  return items;
}

/**
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]
 */
export function createFeeds(store, { now = () => Date.now() } = {}) {
  const feeds = store.scoped('feeds'); // id -> subscription; plus '#seq' -> counter
  const SEQ = '#seq';

  const nextId = () => {
    const n = Number(feeds.get(SEQ) ?? 0) + 1;
    feeds.set(SEQ, n);
    return `f${n}`;
  };

  const all = () => feeds.list().filter((e) => e.key !== SEQ).map((e) => ({ id: e.key, ...e.value }));

  /** This chat's subscriptions, oldest first. */
  const list = (chatId) => all().filter((f) => f.chatId === chatId).sort((a, b) => a.addedAt - b.addedAt);

  /**
   * Subscribe `chatId` to an http(s) feed URL. Returns the new id, or a reason it was rejected.
   * @returns {{ ok: true, id: string } | { ok: false, reason: 'bad-url' | 'too-many', max?: number }}
   */
  function add({ chatId, url }) {
    const u = String(url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return { ok: false, reason: 'bad-url' };
    if (list(chatId).length >= MAX_FEEDS) return { ok: false, reason: 'too-many', max: MAX_FEEDS };
    const id = nextId();
    feeds.set(id, { chatId, url: u, seen: [], checked: false, addedAt: now() });
    return { ok: true, id };
  }

  /** Remove a subscription that belongs to `chatId`. */
  function remove(id, chatId) {
    const f = feeds.get(id);
    if (!f || f.chatId !== chatId) return { ok: false, reason: 'not-found' };
    feeds.delete(id);
    return { ok: true };
  }

  /** Remove every subscription of a chat (e.g. the bot left the group). Returns the count. */
  function clearChat(chatId) {
    const mine = all().filter((f) => f.chatId === chatId);
    for (const f of mine) feeds.delete(f.id);
    return mine.length;
  }

  /**
   * Check every feed: fetch, parse, and deliver entries not yet seen (capped per check). The first
   * successful check only sets a baseline (records current ids, posts nothing). `deliver` may DECLINE
   * (return false) for an ineligible chat - then we stop that feed and leave its un-sent entries for
   * the next tick. A fetch or parse failure is swallowed (best-effort). Returns the count delivered.
   *
   * @param {(url: string) => Promise<string>} fetchText  Fetch a URL's body as text.
   * @param {(chatId: string, text: string) => unknown} deliver
   * @returns {Promise<number>}
   */
  async function tick(fetchText, deliver) {
    let delivered = 0;
    for (const f of all()) {
      let body;
      try {
        body = await fetchText(f.url);
      } catch {
        continue; // network error - try again next tick
      }
      const items = parseFeed(String(body ?? '').slice(0, MAX_BODY));
      if (!items.length) continue; // unparseable / empty - leave the baseline unset, retry later
      // Re-read after the await: an inbound `feed remove` may have landed on the shared store.
      const cur = feeds.get(f.id);
      if (!cur || cur.chatId !== f.chatId) continue;
      // Compare against (and remember) ONLY the top window, capped to MAX_SEEN. `seen` is a SNAPSHOT of the
      // last check's ids, so it always fully covers the candidates - an entry can never scroll out of
      // `seen` while still in view, which previously made a feed with >MAX_SEEN items re-post old entries
      // forever. New entries appear at the top, so they always fall inside the window.
      const candidates = items.slice(0, MAX_SEEN);
      const ids = candidates.map((it) => it.id);
      if (!cur.checked) {
        feeds.set(f.id, { ...cur, checked: true, seen: ids });
        continue; // baseline only - do not post the pre-existing entries
      }
      const seen = new Set(cur.seen ?? []);
      const fresh = candidates.filter((it) => !seen.has(it.id));
      // Post at most MAX_ITEMS_PER_CHECK per check (no burst from a busy feed), tracking what ACTUALLY went
      // out. A `false` return - an ineligible chat, OR a transient send failure mid-batch - stops this feed
      // for now but keeps whatever already delivered.
      const justSent = [];
      for (const it of fresh.slice(0, MAX_ITEMS_PER_CHECK)) {
        const r = await deliver(f.chatId, it.link ? `${it.title}\n${it.link}` : it.title);
        if (r === false) break;
        justSent.push(it.id);
        delivered++;
      }
      // Advance `seen` to the window items that were EITHER already seen OR just delivered - never the whole
      // window. Undelivered-fresh items (declined mid-batch, or beyond the per-check cap) stay unseen, so
      // they post on a later check: never silently dropped (the cap defers, it does not discard), never
      // re-posted after a partial batch. Still bounded by the window, so it keeps the snapshot that stops a
      // >MAX_SEEN feed re-posting old entries. Re-read in case `feed remove` landed during delivery.
      const sent = new Set(justSent);
      const nextSeen = ids.filter((id) => seen.has(id) || sent.has(id));
      const latest = feeds.get(f.id);
      if (latest && latest.chatId === f.chatId) feeds.set(f.id, { ...latest, seen: nextSeen });
    }
    return delivered;
  }

  return { add, list, remove, clearChat, tick };
}
