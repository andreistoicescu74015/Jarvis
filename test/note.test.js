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

test('note: get and del work by a STABLE number that never shifts under a deletion', async () => {
  // Numbers used to be positions, so deleting #1 renumbered everything after it: a number read from
  // an earlier listing then pointed at a different note, and "del 2" deleted the wrong one.
  const store = createStore({ path: ':memory:' });
  const out = await run(store, [
    'jarvis note add a',
    'jarvis note add b',
    'jarvis note add c',
    'jarvis note get 2',
    'jarvis note del 1',
    'jarvis note list',
    'jarvis note get 3',
    'jarvis note add d',
  ]);
  assert.equal(out[3], 'b');
  assert.match(out[4], /Deleted note #1: a/);
  assert.equal(out[5], 'Notes\n2. b\n3. c'); // the survivors keep the numbers they were listed under
  assert.equal(out[6], 'c'); // and "get 3" still means the same note it meant before
  assert.match(out[7], /Added note #4/); // a new note never reuses a freed number
  store.close();
});

test('note: a chat whose notes predate stable ids keeps working, numbered as it was', async () => {
  const store = createStore({ path: ':memory:' });
  store.scoped('private:c1').set('notes', ['old one', 'old two']); // the legacy bare-array shape
  const out = await run(store, ['jarvis note list', 'jarvis note del 1', 'jarvis note list', 'jarvis note add fresh']);
  assert.equal(out[0], 'Notes\n1. old one\n2. old two'); // same numbers the chat already saw
  assert.match(out[1], /Deleted note #1: old one/);
  assert.equal(out[2], 'Notes\n2. old two');
  assert.match(out[3], /Added note #3/); // the counter continues past the migrated notes
  store.close();
});

test('note: a long list is capped to the newest, saying what it left out', async () => {
  // At the 500-note cap a full listing runs past what one WhatsApp message can carry: the send fails
  // and the reader gets silence. So a listing shows a slice and says so.
  const store = createStore({ path: ':memory:' });
  await run(store, Array.from({ length: 25 }, (_, n) => `jarvis note add nota ${n + 1}`));
  const [listing] = await run(store, ['jarvis note list']);
  const lines = listing.split('\n');
  assert.equal(lines.length, 22); // title + 20 notes + the footer
  assert.match(lines[1], /^6\. nota 6$/); // the newest 20, so it starts at #6
  assert.match(lines[20], /^25\. nota 25$/);
  assert.match(listing, /Showing the newest 20 of 25/);
  assert.match(listing, /note get <n>/); // and how to reach one of the rest
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
