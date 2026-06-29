import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
import { createLinks } from '../src/core/links.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createFeeds } from '../src/core/feeds.js';
import { toPlain } from '../src/core/format.js';
import groups from '../src/commands/groups.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

function setup() {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, groups]), {
    owner: 'boss',
    store,
    requireActivation: true,
    listGroups: async () => [{ id: 'g@g.us', name: 'G' }],
  });
  return { store, handle };
}

test('activation gate: a non-owner command is silent in an inactive group', async () => {
  const { store, handle } = setup();
  const out = await handle({ text: 'jarvis ping', sender: 'u', level: 'group', chatId: 'g@g.us' });
  assert.equal(out, undefined); // dormant until the group is activated
  store.close();
});

test('activation gate: the owner auto-activates an inactive group just by addressing it', async () => {
  const { store, handle } = setup();
  // the owner's command in an inactive group activates it, then runs
  assert.equal(toPlain(await handle({ text: 'jarvis ping', sender: 'boss', level: 'group', chatId: 'g@g.us' })), 'pong');
  assert.equal(createActivation(store).isActive('g@g.us'), true);
  // the fresh activation is admin-only: a non-admin is blocked, an admin passes
  assert.equal(await handle({ text: 'jarvis ping', sender: 'u', level: 'group', chatId: 'g@g.us' }), undefined);
  assert.equal(toPlain(await handle({ text: 'jarvis ping', sender: 'u', level: 'group', chatId: 'g@g.us', isAdmin: true })), 'pong');
  store.close();
});

test('activation gate: the owner can also activate explicitly with `groups activate`', async () => {
  const { store, handle } = setup();
  const act = toPlain(await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(act, /Activated Jarvis in/);
  assert.equal(createActivation(store).isActive('g@g.us'), true);
  store.close();
});

test('activation gate: once activated, commands work for everyone in the group', async () => {
  const { store, handle } = setup();
  createActivation(store).activate('g@g.us', 'boss');
  const out = toPlain(await handle({ text: 'jarvis ping', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.equal(out, 'pong');
  store.close();
});

test('activation gate: a community is gated like a group', async () => {
  const { store, handle } = setup();
  assert.equal(await handle({ text: 'jarvis ping', sender: 'u', level: 'community', chatId: 'c@g.us' }), undefined);
  createActivation(store).activate('c@g.us', 'boss');
  assert.equal(toPlain(await handle({ text: 'jarvis ping', sender: 'u', level: 'community', chatId: 'c@g.us' })), 'pong');
  store.close();
});

test('activation gate: private chats are never gated by activation', async () => {
  const { store, handle } = setup();
  // the owner (not blocked by the private lockdown) gets a reply in a DM - no activation involved
  const out = toPlain(await handle({ text: 'jarvis ping', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.equal(out, 'pong');
  store.close();
});

test('activation gate: off by default (requireActivation unset) - groups respond', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store }); // no requireActivation
  const out = toPlain(await handle({ text: 'jarvis ping', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.equal(out, 'pong');
  store.close();
});

test('activation: a fresh activation announces in the group', async () => {
  const store = createStore({ path: ':memory:' });
  const sent = [];
  const handle = createDispatcher(createRegistry([ping, groups]), {
    owner: 'boss',
    store,
    requireActivation: true,
    send: (target, text) => sent.push({ target, text }),
  });
  await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'group', chatId: 'g@g.us' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'g@g.us');
  assert.match(toPlain(sent[0].text), /Jarvis is active here/);
  // re-activating an already-active group does not re-announce
  await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'group', chatId: 'g@g.us' });
  assert.equal(sent.length, 1);
  store.close();
});

test('activation umbrella: activating a community opens the gate for a sub-group with no own entry', async () => {
  const { store, handle } = setup();
  const activation = createActivation(store);
  const sub = { text: 'jarvis ping', sender: 'u', level: 'community', chatId: 's@g.us', community: 'c@g.us' };
  assert.equal(await handle(sub), undefined); // inactive community -> silent for a non-owner
  activation.activate('c@g.us', 'boss'); // activate the community (the umbrella)
  assert.equal(toPlain(await handle(sub)), 'pong'); // the sub-group is now active...
  assert.equal(activation.isActive('s@g.us'), false); // ...purely via the umbrella, no own entry
  store.close();
});

test('activation umbrella: deactivating a community reverts umbrella-only groups but keeps individual ones', async () => {
  const { store, handle } = setup();
  const activation = createActivation(store);
  activation.activate('c@g.us', 'boss'); // umbrella on
  activation.activate('s2@g.us', 'boss'); // s2 also activated on its own
  const s1 = { text: 'jarvis ping', sender: 'u', level: 'community', chatId: 's1@g.us', community: 'c@g.us' };
  const s2 = { text: 'jarvis ping', sender: 'u', level: 'community', chatId: 's2@g.us', community: 'c@g.us' };
  assert.equal(toPlain(await handle(s1)), 'pong'); // via umbrella
  assert.equal(toPlain(await handle(s2)), 'pong'); // via own entry (and umbrella)
  activation.deactivate('c@g.us'); // umbrella off
  assert.equal(await handle(s1), undefined); // s1 had no own entry -> silent again
  assert.equal(toPlain(await handle(s2)), 'pong'); // s2 keeps its own activation
  store.close();
});

test('activation umbrella: the owner addressing the announcement group activates the community', async () => {
  const { store, handle } = setup();
  const activation = createActivation(store);
  // an announcement group's own id IS the community id, so activating it umbrellas the community
  const ann = { text: 'jarvis ping', sender: 'boss', level: 'community', chatId: 'c@g.us', community: 'c@g.us' };
  assert.equal(toPlain(await handle(ann)), 'pong'); // owner auto-activates by addressing
  assert.equal(activation.isActive('c@g.us'), true);
  const sub = { text: 'jarvis ping', sender: 'u', level: 'community', chatId: 's@g.us', community: 'c@g.us' };
  assert.equal(toPlain(await handle(sub)), 'pong'); // a non-owner sub-group is now covered
  store.close();
});

test('activation umbrella: addressing the announcement group is LEAN - it does not lock the group admins-only', async () => {
  const { store, handle } = setup();
  // the owner addresses the announcement group (own id == community id) -> lean umbrella activation
  await handle({ text: 'jarvis ping', sender: 'boss', level: 'community', chatId: 'c@g.us', community: 'c@g.us' });
  // unlike a normal group activation (admins-only), the announcement group stays open: a non-admin passes
  const member = { text: 'jarvis ping', sender: 'u', level: 'community', chatId: 'c@g.us', community: 'c@g.us', isAdmin: false };
  assert.equal(toPlain(await handle(member)), 'pong');
  store.close();
});

test('activation: deactivating a group unlinks it and wipes its own data', async () => {
  const store = createStore({ path: ':memory:' });
  const activation = createActivation(store);
  activation.activate('gA@g.us', 'boss');
  activation.activate('gB@g.us', 'boss');
  // link gA and gB (over the same store the dispatcher uses), and give gA some own data
  const links = createLinks(store, {
    isActivated: (id) => activation.isActive(id),
    clearNamespace: (ns) => store.clearNamespace(ns),
  });
  links.accept(links.propose('gA@g.us'), 'gB@g.us');
  store.scoped('group:gA@g.us').set('note', 'a-data');
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, requireActivation: true });
  // the owner deactivates gA from a DM
  await handle({ text: 'jarvis groups deactivate gA@g.us', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.equal(activation.isActive('gA@g.us'), false); // deactivated
  assert.equal(store.scoped('group:gA@g.us').get('note'), undefined); // its own data wiped
  // the 2-group overlay dissolved: gB is solo again
  assert.deepEqual(createLinks(store).chats('gB@g.us'), ['gB@g.us']);
  store.close();
});

test('activation: deactivating a group also clears its schedules and feeds (stops proactive output)', async () => {
  const store = createStore({ path: ':memory:' });
  const activation = createActivation(store);
  activation.activate('gA@g.us', 'boss');
  const scheduler = createScheduler(store);
  const feeds = createFeeds(store);
  scheduler.add({ chatId: 'gA@g.us', createdBy: 'boss', when: 'in 1h', text: 'reminder' });
  feeds.add({ chatId: 'gA@g.us', url: 'https://ex.com/rss' });
  assert.equal(scheduler.list('gA@g.us').length, 1);
  assert.equal(feeds.list('gA@g.us').length, 1);
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, requireActivation: true, scheduler, feeds });
  await handle({ text: 'jarvis groups deactivate gA@g.us', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.equal(activation.isActive('gA@g.us'), false);
  assert.equal(scheduler.list('gA@g.us').length, 0); // proactive jobs gone
  assert.equal(feeds.list('gA@g.us').length, 0); // feed subscriptions gone
  store.close();
});
