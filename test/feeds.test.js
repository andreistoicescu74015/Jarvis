import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createFeeds, parseFeed } from '../src/core/feeds.js';

const RSS = `<?xml version="1.0"?><rss><channel>
  <title>Blog</title>
  <item><title>First post</title><link>https://ex.com/1</link><guid>g1</guid></item>
  <item><title><![CDATA[Second & best]]></title><link>https://ex.com/2</link><guid>g2</guid></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed>
  <title>Site</title>
  <entry><title>Alpha</title><link href="https://ex.com/a"/><id>a1</id></entry>
  <entry><title>Beta</title><link href="https://ex.com/b"/><id>a2</id></entry>
</feed>`;

test('parseFeed: reads RSS items (title, link, guid; CDATA + entities)', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 'g1', title: 'First post', link: 'https://ex.com/1' });
  assert.equal(items[1].title, 'Second & best'); // CDATA stripped, &amp; decoded
  assert.equal(items[1].id, 'g2');
});

test('parseFeed: reads Atom entries (link href, id)', () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 'a1', title: 'Alpha', link: 'https://ex.com/a' });
});

test('parseFeed: returns [] for junk or empty input (never throws)', () => {
  assert.deepEqual(parseFeed('not xml at all'), []);
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(undefined), []);
});

test('feeds: add validates the URL and bounds the count; list/remove are chat-scoped', () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  assert.equal(f.add({ chatId: 'A', url: 'not-a-url' }).reason, 'bad-url');
  const r = f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  assert.equal(r.ok, true);
  f.add({ chatId: 'B', url: 'http://other.com/feed' });
  assert.deepEqual(f.list('A').map((x) => x.url), ['https://ex.com/rss']);
  assert.equal(f.remove(r.id, 'B').ok, false); // not B's feed
  assert.equal(f.remove(r.id, 'A').ok, true);
  assert.equal(f.list('A').length, 0);
  store.close();
});

test('feeds: the first check is a baseline (posts nothing); later checks post only new entries', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  const sent = [];
  const deliver = (chatId, text) => { sent.push({ chatId, text }); return true; };
  assert.equal(await f.tick(async () => RSS, deliver), 0); // baseline: 2 existing items, nothing posted
  assert.equal(sent.length, 0);
  // A new item appears at the top of the feed.
  const RSS2 = RSS.replace('<item><title>First post</title>', '<item><title>Third</title><link>https://ex.com/3</link><guid>g3</guid></item><item><title>First post</title>');
  assert.equal(await f.tick(async () => RSS2, deliver), 1); // only the new entry
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Third\nhttps:\/\/ex\.com\/3/);
  assert.equal(await f.tick(async () => RSS2, deliver), 0); // no change -> nothing new
  store.close();
});

test('feeds: a declined delivery leaves the entry unsent for the next check', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  await f.tick(async () => RSS, () => true); // baseline
  const RSS2 = RSS.replace('<item><title>First post</title>', '<item><title>New</title><link>https://ex.com/n</link><guid>gn</guid></item><item><title>First post</title>');
  assert.equal(await f.tick(async () => RSS2, () => false), 0); // chat ineligible -> declined, not marked seen
  const sent = [];
  assert.equal(await f.tick(async () => RSS2, (_c, t) => { sent.push(t); return true; }), 1); // eligible again -> posts
  assert.equal(sent.length, 1);
  store.close();
});

test('feeds: a fetch error or empty body is swallowed; the baseline is set only on a real fetch', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  assert.equal(await f.tick(async () => { throw new Error('offline'); }, () => true), 0); // threw -> swallowed
  assert.equal(await f.tick(async () => '', () => true), 0); // empty -> nothing
  assert.equal(await f.tick(async () => RSS, () => true), 0); // first REAL fetch -> baseline (posts 0)
  const RSS2 = RSS.replace('</channel>', '<item><title>Z</title><link>https://ex.com/z</link><guid>gz</guid></item></channel>');
  assert.equal(await f.tick(async () => RSS2, () => true), 1); // the new entry posts (baseline was set, not skipped)
  store.close();
});

test("feeds: clearChat removes only that chat's subscriptions", () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/1' });
  f.add({ chatId: 'A', url: 'https://ex.com/2' });
  f.add({ chatId: 'B', url: 'https://ex.com/3' });
  assert.equal(f.clearChat('A'), 2);
  assert.equal(f.list('A').length, 0);
  assert.equal(f.list('B').length, 1);
  store.close();
});

test('parseFeed: decodes named, decimal, and hex entities in titles', () => {
  const xml = '<rss><channel><item><title>caf&#233; &amp; t&#xe9;a &quot;x&quot;</title><guid>g1</guid></item></channel></rss>';
  assert.equal(parseFeed(xml)[0].title, 'café & téa "x"');
});

test('parseFeed: an Atom entry with multiple links prefers rel="alternate" over rel="self"', () => {
  const xml = '<feed><entry><title>Post</title><link rel="self" href="https://ex.com/feed.atom"/><link rel="alternate" href="https://ex.com/post/1"/><id>a1</id></entry></feed>';
  assert.equal(parseFeed(xml)[0].link, 'https://ex.com/post/1');
});

test('feeds: a feed with more than MAX_SEEN (200) items never re-posts old entries', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/big' });
  const big = (extra = '') => `<rss><channel>${extra}${Array.from({ length: 250 }, (_, i) => `<item><title>T${i}</title><guid>g${i}</guid></item>`).join('')}</channel></rss>`;
  assert.equal(await f.tick(async () => big(), () => true), 0); // baseline records the window, posts nothing
  // The bug re-posted ~5 stale items every tick; the snapshot fix must post NOTHING for an unchanged feed.
  assert.equal(await f.tick(async () => big(), () => true), 0);
  assert.equal(await f.tick(async () => big(), () => true), 0);
  // A genuinely new entry at the top posts exactly once, then never again.
  const sent = [];
  assert.equal(await f.tick(async () => big('<item><title>NEW</title><guid>gnew</guid></item>'), (_c, t) => { sent.push(t); return true; }), 1);
  assert.match(sent[0], /NEW/);
  assert.equal(await f.tick(async () => big('<item><title>NEW</title><guid>gnew</guid></item>'), () => true), 0);
  store.close();
});

test('feeds: a partial batch (first sent, then a transient decline) never re-posts what already went out', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  const base = '<rss><channel><item><title>Old</title><guid>old</guid></item></channel></rss>';
  await f.tick(async () => base, () => true); // baseline
  // Two new entries appear; the SECOND delivery hits a transient failure (false) mid-batch.
  const two =
    '<rss><channel><item><title>A1</title><guid>n1</guid></item><item><title>A2</title><guid>n2</guid></item><item><title>Old</title><guid>old</guid></item></channel></rss>';
  let calls = 0;
  const sent = [];
  const flaky = (_c, t) => { calls += 1; if (calls === 2) return false; sent.push(t); return true; };
  assert.equal(await f.tick(async () => two, flaky), 1); // only the first actually went out
  assert.deepEqual(sent, ['A1']);
  // Next check: the delivered entry must NOT repeat - only the still-undelivered one posts.
  const after = [];
  await f.tick(async () => two, (_c, t) => { after.push(t); return true; });
  assert.deepEqual(after, ['A2']);
  store.close();
});

test('feeds: more new entries than the per-check cap are deferred across checks, never dropped', async () => {
  const store = createStore({ path: ':memory:' });
  const f = createFeeds(store, { now: () => 1 });
  f.add({ chatId: 'A', url: 'https://ex.com/rss' });
  const feed = (n) =>
    `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>N${i}</title><guid>g${i}</guid></item>`).join('')}<item><title>Old</title><guid>old</guid></item></channel></rss>`;
  await f.tick(async () => feed(0), () => true); // baseline: just the "Old" item
  // 8 new entries (more than MAX_ITEMS_PER_CHECK = 5) appear at once.
  const sent = [];
  const deliver = (_c, t) => { sent.push(t.split('\n')[0]); return true; };
  assert.equal(await f.tick(async () => feed(8), deliver), 5); // capped at 5 this check
  assert.equal(await f.tick(async () => feed(8), deliver), 3); // the remaining 3 next check
  assert.equal(await f.tick(async () => feed(8), deliver), 0); // all delivered, nothing repeats
  assert.equal(sent.length, 8); // every entry posted exactly once
  assert.equal(new Set(sent).size, 8);
  store.close();
});
