import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
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
