import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createLinks } from '../src/core/links.js';
import { createActivation } from '../src/core/activation.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import note from '../src/commands/note.js';
import ping from '../src/commands/ping.js';
import blacklist from '../src/commands/blacklist.js';

const probe = { name: 'probe', summary: 'echo the overlay', run: (ctx) => ctx.chats.slice().sort().join(',') };

/** A store where two active groups gA/gB are linked into one overlay (done over the same store). */
function linkedStore() {
  const store = createStore({ path: ':memory:' });
  const activation = createActivation(store);
  activation.activate('gA', 'boss');
  activation.activate('gB', 'boss');
  const links = createLinks(store, {
    isActivated: (id) => activation.isActive(id),
    clearNamespace: (ns) => store.clearNamespace(ns),
  });
  links.accept(links.propose('gA'), 'gB');
  return store;
}

test('links+dispatch: linked groups share one data context (notes visible across)', async () => {
  const handle = createDispatcher(createRegistry([note]), { store: linkedStore() });
  await handle({ text: 'jarvis note add shared', sender: 'u', chatId: 'gA', level: 'group', isAdmin: true });
  const out = toPlain(await handle({ text: 'jarvis note list', sender: 'u', chatId: 'gB', level: 'group', isAdmin: true }));
  assert.match(out, /shared/); // gB sees the note added in gA
});

test('links+dispatch: ctx.chats reflects the overlay members', async () => {
  const handle = createDispatcher(createRegistry([probe]), { store: linkedStore() });
  assert.equal(await handle({ text: 'jarvis probe', sender: 'u', chatId: 'gA', level: 'group', isAdmin: true }), 'gA,gB');
});

test('links+dispatch: access lists are NOT shared across a link (only data is)', async () => {
  const handle = createDispatcher(createRegistry([ping, blacklist]), { store: linkedStore() });
  const admA = (text) => handle({ text, sender: 'adm', chatId: 'gA', level: 'group', isAdmin: true });
  await admA('jarvis blacklist ping add rando');
  await admA('jarvis blacklist ping enable');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'rando', chatId: 'gA', level: 'group' }), undefined); // blocked in gA
  assert.equal(toPlain(await handle({ text: 'jarvis ping', sender: 'rando', chatId: 'gB', level: 'group' })), 'pong'); // not in gB
});

test('links+dispatch: without a link, ctx.chats is just the current chat', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([probe]), { store });
  assert.equal(await handle({ text: 'jarvis probe', sender: 'u', chatId: 'X', level: 'group' }), 'X');
});

test('links+dispatch: without a store, ctx.chats falls back to the current chat', async () => {
  const handle = createDispatcher(createRegistry([probe]));
  assert.equal(await handle({ text: 'jarvis probe', sender: 'u', chatId: 'Z' }), 'Z');
});
