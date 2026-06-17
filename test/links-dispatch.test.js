import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createLinks } from '../src/core/links.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import note from '../src/commands/note.js';

const probe = { name: 'probe', summary: 'echo the cluster', run: (ctx) => ctx.chats.slice().sort().join(',') };

test('links+dispatch: linked chats share the store (notes visible across the link)', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([note]), { store });
  await handle({ text: 'jarvis note add shared', sender: 'u', chatId: 'A', level: 'group' });
  // link A and B - the dispatcher scopes a chat as `${level}:${chatId}`
  createLinks(store).link('A', 'group:A', 'B', 'group:B');
  const out = await handle({ text: 'jarvis note list', sender: 'u', chatId: 'B', level: 'group' });
  assert.match(out, /shared/); // B sees the note added in A
});

test('links+dispatch: ctx.chats reflects the link cluster', async () => {
  const store = createStore({ path: ':memory:' });
  createLinks(store).link('A', 'group:A', 'B', 'group:B');
  const handle = createDispatcher(createRegistry([probe]), { store });
  assert.equal(await handle({ text: 'jarvis probe', sender: 'u', chatId: 'A', level: 'group' }), 'A,B');
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
