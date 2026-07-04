import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createOwnerResolver } from '../src/core/owner.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import owner from '../src/commands/owner.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };
const meta = (store) => store.scoped('owner-meta');

test('owner persistence: a claim survives a "restart" (a fresh resolver over the same store)', () => {
  const store = createStore({ path: ':memory:' });
  createOwnerResolver({ meta: meta(store) }).claim('alice@s.whatsapp.net');
  const restarted = createOwnerResolver({ meta: meta(store) });
  assert.equal(restarted.current, 'alice@s.whatsapp.net');
  assert.equal(restarted.isOwner('alice@s.whatsapp.net'), true);
  store.close();
});

test('owner persistence: OWNER_JID silently invalidates a previously claimed owner', () => {
  const store = createStore({ path: ':memory:' });
  createOwnerResolver({ meta: meta(store) }).claim('alice@x');
  const envOwned = createOwnerResolver({ owner: 'boss@x', meta: meta(store) });
  assert.equal(envOwned.current, 'boss@x'); // env wins
  assert.equal(envOwned.isOwner('alice@x'), false);
  assert.equal(meta(store).get('claimed'), undefined); // the stale claim is dropped, not kept around
  // ...so if the env var is later removed, the old claim does NOT resurface
  const envRemoved = createOwnerResolver({ meta: meta(store) });
  assert.equal(envRemoved.current, '');
  store.close();
});

test('owner persistence: resign clears the persisted claim', () => {
  const store = createStore({ path: ':memory:' });
  const r = createOwnerResolver({ meta: meta(store) });
  r.claim('alice@x');
  r.resign();
  assert.equal(meta(store).get('claimed'), undefined);
  assert.equal(createOwnerResolver({ meta: meta(store) }).current, '');
  store.close();
});

test('owner persistence: without a meta store the claim stays ephemeral (unchanged behavior)', () => {
  const r = createOwnerResolver({});
  r.claim('alice@x');
  assert.equal(r.current, 'alice@x'); // in-memory for this process only
});

test('owner persistence: dispatch - a claimed owner is still the owner after a restart', async () => {
  const store = createStore({ path: ':memory:' });
  const h1 = createDispatcher(createRegistry([owner, ping]), { store });
  await h1({ text: 'jarvis owner claim', sender: 'alice', level: 'private', chatId: 'dm' });
  // "restart": a brand-new dispatcher over the same store
  const h2 = createDispatcher(createRegistry([owner, ping]), { store });
  // alice is still the owner - she passes the (persisted) private lockdown...
  assert.equal(await h2({ text: 'jarvis ping', sender: 'alice', level: 'private', chatId: 'dm' }), 'pong');
  // ...and the old claim race is closed: a stranger's post-restart claim finds the slot taken,
  // and (being locked out of DMs, with the owner exemption over) gets pure silence
  assert.equal(await h2({ text: 'jarvis owner claim', sender: 'mallory', level: 'private', chatId: 'dm' }), undefined);
  store.close();
});

test('owner persistence: dispatch - OWNER_JID takes over from a stale claim on the same store', async () => {
  const store = createStore({ path: ':memory:' });
  const h1 = createDispatcher(createRegistry([owner, ping]), { store });
  await h1({ text: 'jarvis owner claim', sender: 'alice', level: 'private', chatId: 'dm' });
  // "restart" with OWNER_JID configured: boss owns the bot, alice's claim is silently gone
  const h2 = createDispatcher(createRegistry([owner, ping]), { store, owner: 'boss' });
  assert.equal(await h2({ text: 'jarvis ping', sender: 'boss', level: 'private', chatId: 'dm' }), 'pong');
  assert.equal(store.scoped('owner-meta').get('claimed'), undefined);
  assert.equal(await h2({ text: 'jarvis ping', sender: 'alice', level: 'private', chatId: 'dm' }), undefined); // just another stranger now
  store.close();
});
