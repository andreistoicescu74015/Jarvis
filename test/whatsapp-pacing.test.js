import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/whatsapp/pacing.js';

test('pacing: spaces consecutive sends by at least minIntervalMs', () => {
  let t = 1000;
  const limiter = createRateLimiter({ minIntervalMs: 800, now: () => t });
  assert.equal(limiter.nextWaitMs(), 0); // first send is immediate
  t = 1100; // 100ms later
  assert.equal(limiter.nextWaitMs(), 700); // wait to reach 800ms spacing
  t = 3000; // long gap
  assert.equal(limiter.nextWaitMs(), 0); // no wait needed
});

test('pacing: jitter is added on top of the spacing', () => {
  let t = 0;
  const limiter = createRateLimiter({ minIntervalMs: 500, now: () => t });
  assert.equal(limiter.nextWaitMs(0), 0);
  t = 100;
  assert.equal(limiter.nextWaitMs(50), 450); // 400 to reach spacing + 50 jitter
});
