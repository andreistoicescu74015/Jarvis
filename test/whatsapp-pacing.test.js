import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, typingDelayMs } from '../src/whatsapp/pacing.js';

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

test('typingDelayMs: proportional to length, capped, and 0 for empty/garbage', () => {
  assert.equal(typingDelayMs(0, { perCharMs: 50, maxMs: 6000 }), 0);
  assert.equal(typingDelayMs(10, { perCharMs: 50, maxMs: 6000 }), 500); // 10 * 50
  assert.equal(typingDelayMs(1000, { perCharMs: 50, maxMs: 6000 }), 6000); // capped
  assert.equal(typingDelayMs(10), 500); // defaults: 50ms/char
  assert.equal(typingDelayMs(NaN), 0); // garbage -> no delay
});

test('typingDelayMs: the default cap keeps even a long reply from feeling stalled', () => {
  // The wait is what a user sits through after asking. A `help` reply used to hold the indicator for
  // six seconds, which reads as a dead bot rather than a human composing.
  assert.equal(typingDelayMs(1291), 2500);
  assert.equal(typingDelayMs(20), 1000); // short replies stay proportional
  assert.equal(typingDelayMs(1291, { maxMs: 6000 }), 6000); // still tunable for anyone who wants the old feel
});
