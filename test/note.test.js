import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createApp } from '../src/core/app.js';
import { createStore } from '../src/store/index.js';
import { createTestAdapter } from './helpers.js';
import note from '../src/commands/note.js';

// Drive the `note` command through the full dispatcher with a real (in-memory) store.
async function run(store, texts, msg = { chatId: 'c1', level: 'private' }) {
  const adapter = createTestAdapter();
  const app = createApp(adapter, {
    handle: createDispatcher(createRegistry([note]), { store }),
  });
  await app.start();
  for (const text of texts) await adapter.receive({ text, ...msg });
  return adapter.sent.map((s) => s.text);
}

test('note: add then list (persisted through ctx.store)', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, ['jarvis note add milk', 'jarvis note add bread', 'jarvis note list']);
  assert.match(out[0], /Added note #1\./);
  assert.match(out[1], /Added note #2\./);
  assert.equal(out[2], 'Notes\n1. milk\n2. bread');
  store.close();
});

test('note: get and del work by 1-based index', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, [
    'jarvis note add a',
    'jarvis note add b',
    'jarvis note get 2',
    'jarvis note del 1',
    'jarvis note list',
  ]);
  assert.equal(out[2], 'b');
  assert.match(out[3], /Deleted note: a/);
  assert.equal(out[4], 'Notes\n1. b');
  store.close();
});

test('note: notes are scoped per conversation', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([note]), { store });

  const a1 = createTestAdapter();
  await createApp(a1, { handle }).start();
  await a1.receive({ text: 'jarvis note add secret', chatId: 'c1', level: 'private' });

  const a2 = createTestAdapter();
  await createApp(a2, { handle }).start();
  await a2.receive({ text: 'jarvis note list', chatId: 'c2', level: 'private' });
  assert.equal(a2.sent.at(-1).text, 'No notes yet.');

  store.close();
});

test('note: usage hint when misused', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, ['jarvis note', 'jarvis note add']);
  assert.match(out[0], /Usage: jarvis note/);
  assert.match(out[1], /Usage: jarvis note add/);
  store.close();
});

test('note: the subcommand is case-insensitive', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, ['jarvis note ADD milk', 'jarvis note LIST']);
  assert.match(out[0], /Added note #1\./);
  assert.equal(out[1], 'Notes\n1. milk'); // the note text keeps its original case
  store.close();
});

test('note: rejects an over-long note and does not store it', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, [`jarvis note add ${'x'.repeat(1001)}`, 'jarvis note list']);
  assert.match(out[0], /too long/i);
  assert.equal(out[1], 'No notes yet.'); // nothing was stored
  store.close();
});

test('note: caps the number of notes per conversation', async () => {
  const store = createStore({ path: ':memory:' });
  const adds = Array.from({ length: 500 }, (_, i) => `jarvis note add n${i}`);
  const out = await run(store, [...adds, 'jarvis note add overflow']);
  assert.match(out[499], /Added note #500\./);
  assert.match(out[500], /Too many notes/i);
  store.close();
});

test('note: clear removes all notes at once', async () => {
  const store = createStore({ path: ':memory:' });
  const out = await run(store, ['jarvis note add a', 'jarvis note add b', 'jarvis note clear', 'jarvis note list']);
  assert.match(out[2], /Cleared all 2 notes/i);
  assert.equal(out[3], 'No notes yet.');
  store.close();
});
