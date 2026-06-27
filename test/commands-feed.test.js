import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createFeeds } from '../src/core/feeds.js';
import { toPlain } from '../src/core/format.js';
import feed from '../src/commands/feed.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

function setup() {
  const store = createStore({ path: ':memory:' });
  const feeds = createFeeds(store);
  const handle = createDispatcher(createRegistry([ping, feed]), { owner: 'boss', store, feeds });
  return { store, handle };
}
// `feed` is proactive (group-only), so run it as a group admin.
const msg = (text, over = {}) => ({ text, sender: 'u', chatId: 'A', level: 'group', isAdmin: true, ...over });

test('feed command: an admin subscribes, lists, and removes a feed', async () => {
  const { store, handle } = setup();
  assert.match(toPlain(await handle(msg('jarvis feed add https://ex.com/rss'))), /Subscribed/i);
  assert.match(toPlain(await handle(msg('jarvis feed list'))), /https:\/\/ex\.com\/rss/);
  assert.match(toPlain(await handle(msg('jarvis feed remove 1'))), /Removed feed/i);
  assert.match(toPlain(await handle(msg('jarvis feed list'))), /No feeds here/i);
  store.close();
});

test('feed command: rejects a non-http URL and a bad index', async () => {
  const { store, handle } = setup();
  assert.match(toPlain(await handle(msg('jarvis feed add ftp://nope'))), /http\(s\) URL/i);
  assert.match(toPlain(await handle(msg('jarvis feed remove 9'))), /No feed #9/i);
  assert.match(toPlain(await handle(msg('jarvis feed add'))), /Usage/i); // missing url
  assert.match(toPlain(await handle(msg('jarvis feed frobnicate'))), /Usage/i); // unknown subcommand
  store.close();
});

test('feed command: it is group-only proactive (a non-admin member cannot subscribe)', async () => {
  const { store, handle } = setup();
  const out = toPlain(await handle(msg('jarvis feed add https://ex.com/rss', { isAdmin: false, sender: 'member' })));
  assert.match(out, /Not allowed/i);
  store.close();
});
