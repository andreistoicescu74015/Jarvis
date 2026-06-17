import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createOutbox } from '../src/core/outbox.js';
import { createSendBudget } from '../src/core/send-budget.js';

test('outbox: enqueue is FIFO and drain without a budget sends all in order', async () => {
  const o = createOutbox(createStore({ path: ':memory:' }));
  o.enqueue('broadcast', [{ chatId: 'a', text: 'hi' }, { chatId: 'b', text: 'hi' }]);
  assert.equal(o.pending().length, 2);
  const sent = [];
  const r = await o.drain({ deliver: (c) => sent.push(c) });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(r, { sent: 2, remaining: 0 });
});

test('outbox: drain releases only what the budget allows, in order, leaving the rest queued', async () => {
  let now = 0;
  const store = createStore({ path: ':memory:' });
  const o = createOutbox(store);
  const b = createSendBudget(store, {
    now: () => now,
    perCommand: { perHour: 60, perDay: 300 }, // one every 60s
    global: { perHour: 60, perDay: 300 },
  });
  o.enqueue('broadcast', [{ chatId: 'a', text: 'x' }, { chatId: 'b', text: 'x' }, { chatId: 'c', text: 'x' }]);
  const sent = [];
  const deliver = (c) => sent.push(c);
  assert.deepEqual(await o.drain({ deliver, budget: b, at: now }), { sent: 1, remaining: 2 }); // 1 per window
  now += 60_000;
  assert.deepEqual(await o.drain({ deliver, budget: b, at: now }), { sent: 1, remaining: 1 });
  assert.deepEqual(sent, ['a', 'b']); // FIFO preserved across drains
});

test('outbox: a failed delivery is dropped (best-effort, no retry storm)', async () => {
  const o = createOutbox(createStore({ path: ':memory:' }));
  o.enqueue('broadcast', [{ chatId: 'a', text: 'x' }]);
  const r = await o.drain({
    deliver: () => {
      throw new Error('offline');
    },
  });
  assert.equal(r.sent, 0);
  assert.equal(o.pending().length, 0); // dropped, not retried forever
});

test('outbox: with a budget, a failing send drops at most one per window, keeping the rest queued', async () => {
  let now = 0;
  const store = createStore({ path: ':memory:' });
  const o = createOutbox(store);
  const b = createSendBudget(store, {
    now: () => now,
    perCommand: { perHour: 60, perDay: 300 },
    global: { perHour: 60, perDay: 300 },
  });
  o.enqueue('broadcast', [{ chatId: 'a', text: 'x' }, { chatId: 'b', text: 'x' }, { chatId: 'c', text: 'x' }]);
  const r = await o.drain({ deliver: () => { throw new Error('offline'); }, budget: b, at: now });
  assert.equal(r.sent, 0);
  assert.equal(o.pending().length, 2); // only 'a' consumed the window and dropped; b,c survive
});

test('outbox: the queue persists across instances (survives a restart)', () => {
  const store = createStore({ path: ':memory:' });
  createOutbox(store).enqueue('broadcast', [{ chatId: 'a', text: 'x' }]);
  assert.equal(createOutbox(store).pending().length, 1);
});
