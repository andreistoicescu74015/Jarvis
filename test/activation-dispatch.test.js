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

test('activation gate: in an inactive group even the owner only gets the groups command through', async () => {
  const { store, handle } = setup();
  assert.equal(await handle({ text: 'jarvis ping', sender: 'boss', level: 'group', chatId: 'g@g.us' }), undefined);
  // the owner's `groups` command passes, and activates the group from inside
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
  const out = toPlain(await handle({ text: 'jarvis ping', sender: 'u', level: 'private', chatId: 'dm' }));
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
