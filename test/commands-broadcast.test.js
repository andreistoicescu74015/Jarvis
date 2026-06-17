import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createLinks } from '../src/core/links.js';
import { createOutbox } from '../src/core/outbox.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import broadcast from '../src/commands/broadcast.js';
import { toPlain } from '../src/core/format.js';

test('broadcast: queues a DM for every participant across the linked cluster (deduped, bot excluded)', async () => {
  const store = createStore({ path: ':memory:' });
  createLinks(store).link('A', 'group:A', 'B', 'group:B'); // cluster spans A and B
  const outbox = createOutbox(store);
  const participantsOf = async (chat) => ({ A: ['u1', 'u2', 'bot'], B: ['u2', 'u3'] })[chat] ?? [];
  const handle = createDispatcher(createRegistry([broadcast]), {
    store,
    owner: 'boss',
    participantsOf,
    outbox,
    match: (a, b) => a === b, // so 'bot' (in self) is recognised
  });
  const out = await handle({ text: 'jarvis broadcast hello', sender: 'boss', chatId: 'A', level: 'group', self: ['bot'] });
  assert.match(toPlain(out), /Queued broadcast to 3 people/);
  assert.deepEqual(outbox.pending().map((i) => i.chatId).sort(), ['u1', 'u2', 'u3']); // deduped, no bot
  assert.ok(outbox.pending().every((i) => i.text === 'hello' && i.command === 'broadcast'));
});

test('broadcast: owner-only', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([broadcast]), {
    store,
    owner: 'boss',
    participantsOf: async () => ['u1'],
    outbox: createOutbox(store),
  });
  assert.match(await handle({ text: 'jarvis broadcast hi', sender: 'x', chatId: 'A', level: 'group' }), /owner only/);
});

test('broadcast: unavailable without the platform participant capability', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([broadcast]), { store, owner: 'boss', outbox: createOutbox(store) });
  assert.match(await handle({ text: 'jarvis broadcast hi', sender: 'boss', chatId: 'A' }), /unavailable/i);
});

test('broadcast: needs a message', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([broadcast]), {
    store,
    owner: 'boss',
    participantsOf: async () => ['u1'],
    outbox: createOutbox(store),
  });
  assert.match(toPlain(await handle({ text: 'jarvis broadcast', sender: 'boss', chatId: 'A' })), /Usage: jarvis broadcast/);
});
