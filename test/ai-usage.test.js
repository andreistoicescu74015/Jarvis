import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createAiUsage } from '../src/core/ai-usage.js';

const usage = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

test('ai-usage: records per-context and global running totals', () => {
  const store = createStore({ path: ':memory:' });
  const acct = createAiUsage(store, { now: () => 1000 });
  acct.record('g@g.us', usage(30, 12));
  acct.record('g@g.us', usage(10, 5));
  acct.record('private', usage(100, 50));
  const g = acct.summary('g@g.us');
  assert.deepEqual(g.here, { calls: 2, prompt: 40, completion: 17, total: 57, since: 1000 });
  assert.deepEqual(g.global, { calls: 3, prompt: 140, completion: 67, total: 207, since: 1000 });
  const p = acct.summary('private');
  assert.equal(p.here.total, 150);
  assert.equal(p.here.calls, 1);
  assert.equal(p.global.total, 207); // the global total is the same seen from any context
  store.close();
});

test('ai-usage: a missing or token-less payload records nothing', () => {
  const store = createStore({ path: ':memory:' });
  const acct = createAiUsage(store, { now: () => 1 });
  acct.record('g@g.us', undefined);
  acct.record('g@g.us', null);
  acct.record('g@g.us', {});
  acct.record('g@g.us', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.deepEqual(acct.summary('g@g.us').global, { calls: 0, prompt: 0, completion: 0, total: 0, since: 1 });
  store.close();
});

test('ai-usage: total falls back to prompt+completion when total_tokens is absent', () => {
  const store = createStore({ path: ':memory:' });
  const acct = createAiUsage(store, { now: () => 1 });
  acct.record('private', { prompt_tokens: 7, completion_tokens: 3 });
  assert.equal(acct.summary('private').here.total, 10);
  store.close();
});

test('ai-usage: totals persist on the same store and keep their original `since`', () => {
  const store = createStore({ path: ':memory:' });
  createAiUsage(store, { now: () => 1 }).record('private', usage(5, 5));
  const reopened = createAiUsage(store, { now: () => 999 });
  assert.equal(reopened.summary('private').here.total, 10);
  assert.equal(reopened.summary('private').here.since, 1); // preserved, not reset to the new clock
  store.close();
});

test('ai-usage: today() accumulates within a day and allows() gates on a cap', () => {
  const store = createStore({ path: ':memory:' });
  let now = new Date('2026-06-27T10:00').getTime();
  const acct = createAiUsage(store, { now: () => now });
  assert.equal(acct.today(), 0);
  assert.equal(acct.allows(100), true); // nothing spent yet
  assert.equal(acct.allows(0), true); // 0 = no cap, always allowed
  acct.record('private', usage(40, 20)); // 60 today
  assert.equal(acct.today(), 60);
  assert.equal(acct.allows(100), true); // under the cap
  assert.equal(acct.allows(60), false); // at the cap blocks (today() < cap is false)
  assert.equal(acct.allows(0), true); // still no-cap regardless of spend
  store.close();
});

test('ai-usage: the daily bucket resets on a new calendar day; cumulative totals do not', () => {
  const store = createStore({ path: ':memory:' });
  let now = new Date('2026-06-27T23:00').getTime();
  const acct = createAiUsage(store, { now: () => now });
  acct.record('private', usage(50, 50)); // 100 today
  assert.equal(acct.today(), 100);
  now = new Date('2026-06-28T01:00').getTime(); // a new day
  assert.equal(acct.today(), 0); // daily bucket auto-resets
  assert.equal(acct.allows(100), true); // budget refreshed
  acct.record('private', usage(5, 0)); // 5 on the new day
  assert.equal(acct.today(), 5); // not 105
  assert.equal(acct.summary('private').here.total, 105); // cumulative is untouched by the daily reset
  store.close();
});

test('ai-usage: the daily bucket counts requests too, and both reset on day rollover', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const acct = createAiUsage(store, { now: () => t });
  acct.record('g@g.us', usage(30, 12));
  acct.record('g@g.us', usage(10, 5));
  assert.equal(acct.today(), 57);
  assert.equal(acct.todayCalls(), 2); // vs the provider's documented requests/day ceiling
  t = new Date('2026-07-05T00:01:00').getTime(); // the local day rolled over
  assert.equal(acct.today(), 0);
  assert.equal(acct.todayCalls(), 0);
  store.close();
});

test('ai-usage: noteLimit remembers the LAST provider throttle for display', () => {
  const store = createStore({ path: ':memory:' });
  let t = 1000;
  const acct = createAiUsage(store, { now: () => t });
  assert.equal(acct.lastLimit(), undefined); // none seen yet
  acct.noteLimit({ type: 'UserByModelByDay', retryAfterSec: 120 });
  assert.deepEqual(acct.lastLimit(), { at: 1000, type: 'UserByModelByDay', retryAfterSec: 120 });
  t = 2000;
  acct.noteLimit({ type: 'Other', retryAfterSec: 5 });
  assert.deepEqual(acct.lastLimit(), { at: 2000, type: 'Other', retryAfterSec: 5 }); // last one wins
  acct.noteLimit({}); // header-less 429: still a valid marker
  assert.deepEqual(acct.lastLimit(), { at: 2000, type: '', retryAfterSec: 0 });
  store.close();
});
