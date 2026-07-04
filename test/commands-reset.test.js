import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import reset from '../src/commands/reset.js';
import note from '../src/commands/note.js';
import { createRules } from '../src/core/rules.js';

const inGroup = (handle, text) => handle({ text, sender: 'boss', chatId: 'gA', level: 'group' }).then(toPlain);

test('reset cmd: the owner resets the current context (its data is cleared)', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([reset, note]), { owner: 'boss', store });
  await inGroup(handle, 'jarvis note add keep-me');
  assert.match(await inGroup(handle, 'jarvis note list'), /keep-me/);
  assert.match(await inGroup(handle, 'jarvis reset'), /reset/i);
  assert.match(await inGroup(handle, 'jarvis note list'), /No notes yet/i);
});

test('reset cmd: reset is owner-only', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([reset]), { owner: 'boss', store });
  assert.match(
    await handle({ text: 'jarvis reset', sender: 'rando', chatId: 'gA', level: 'group' }),
    /Not allowed: owner only/,
  );
});

test('reset cmd: "reset all" wipes the whole store and restarts (keeping the login)', async () => {
  const store = createStore({ path: ':memory:' });
  const lifecycle = { wipe: () => store.clearAll() }; // the real wipe also restarts; here we just wipe
  const handle = createDispatcher(createRegistry([reset, note]), { owner: 'boss', store, lifecycle });
  await handle({ text: 'jarvis note add x', sender: 'boss', chatId: 'gA', level: 'group' });
  assert.match(toPlain(await handle({ text: 'jarvis reset all', sender: 'boss', chatId: 'gA', level: 'group' })), /Wiping all data/i);
  assert.equal(store.scoped('group:gA').get('notes'), undefined); // the store is empty
});

test('reset cmd: "reset all" reports unavailable when no wipe lifecycle is wired', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([reset]), { owner: 'boss', store }); // no lifecycle
  assert.match(await handle({ text: 'jarvis reset all', sender: 'boss', chatId: 'gA', level: 'group' }), /Not available here/i);
});

test('reset cmd: reset also clears this context keyword auto-replies', async () => {
  const store = createStore({ path: ':memory:' });
  const rules = createRules(store); // same store/namespace the dispatcher's own rules engine uses
  const handle = createDispatcher(createRegistry([reset]), { owner: 'boss', store });
  rules.add({ chatId: 'gA', createdBy: 'boss', keyword: 'menu', reply: 'soup' });
  assert.equal(rules.list('gA').length, 1);
  await handle({ text: 'jarvis reset', sender: 'boss', chatId: 'gA', level: 'group' });
  assert.equal(rules.list('gA').length, 0); // an auto-reply is context data, gone with the reset
  store.close();
});
