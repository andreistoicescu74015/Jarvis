import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createSendBudget } from '../src/core/send-budget.js';

const DAY = 86_400_000;

test('send-budget: enforces an even min-interval derived from the hourly rate (no burst)', () => {
  let now = 1_000_000;
  const b = createSendBudget(createStore({ path: ':memory:' }), {
    now: () => now,
    perCommand: { perHour: 60, perDay: 300 }, // 60/h -> one every 60s
    global: { perHour: 3600, perDay: 999_999 }, // loose, so the per-command interval binds
  });
  assert.equal(b.canSend('schedule'), true); // first send is always allowed
  b.record('schedule');
  assert.equal(b.canSend('schedule'), false); // too soon (< 60s)
  now += 59_000;
  assert.equal(b.canSend('schedule'), false);
  now += 1_000; // exactly 60s later
  assert.equal(b.canSend('schedule'), true);
});

test('send-budget: enforces the rolling daily cap', () => {
  let now = 0;
  const b = createSendBudget(createStore({ path: ':memory:' }), {
    now: () => now,
    perCommand: { perHour: 100_000, perDay: 3 }, // tiny interval, so the daily cap binds
    global: { perHour: 100_000, perDay: 999_999 },
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(b.canSend('x'), true);
    b.record('x');
    now += 1_000;
  }
  assert.equal(b.canSend('x'), false); // 3/day reached
  now += DAY; // a full day later, the old sends age out
  assert.equal(b.canSend('x'), true);
});

test('send-budget: per-command budgets are separate; global is shared', () => {
  let now = 0;
  const b = createSendBudget(createStore({ path: ':memory:' }), {
    now: () => now,
    perCommand: { perHour: 3600, perDay: 2 }, // 2/day per command
    global: { perHour: 3600, perDay: 999 },
  });
  b.record('broadcast'); now += 1_000;
  b.record('broadcast'); now += 1_000;
  assert.equal(b.canSend('broadcast'), false); // broadcast hit its own daily cap
  assert.equal(b.canSend('schedule'), true); // schedule has its own budget
});

test('send-budget: the global backstop blocks even when the command is fine', () => {
  let now = 0;
  const b = createSendBudget(createStore({ path: ':memory:' }), {
    now: () => now,
    perCommand: { perHour: 3600, perDay: 999 },
    global: { perHour: 3600, perDay: 2 }, // 2/day across ALL commands
  });
  b.record('a'); now += 1_000;
  b.record('b'); now += 1_000;
  assert.equal(b.canSend('c'), false); // global cap hit regardless of the per-command room
});

test('send-budget: a zero/negative config is clamped, never silently blocking all sends', () => {
  let now = 1_000_000;
  const b = createSendBudget(createStore({ path: ':memory:' }), {
    now: () => now,
    perCommand: { perHour: -5, perDay: 0 }, // nonsense -> clamped to >= 1, not a permanent block
    global: { perHour: 999, perDay: 999 },
  });
  assert.equal(b.canSend('x'), true); // still allowed; without the clamp, perDay 0 would block forever
});

test('send-budget: state persists across instances (a restart cannot reset the rate)', () => {
  let now = 1_000_000;
  const store = createStore({ path: ':memory:' });
  createSendBudget(store, { now: () => now, perCommand: { perHour: 60, perDay: 300 } }).record('schedule');
  const b2 = createSendBudget(store, { now: () => now });
  assert.equal(b2.canSend('schedule'), false); // the min-interval still applies after "restart"
});
