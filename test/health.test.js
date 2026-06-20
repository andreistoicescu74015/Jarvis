import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFresh } from '../src/health.js';

test('health: a recent heartbeat is fresh; an old, missing, or garbage one is not', () => {
  const now = 1_000_000;
  assert.equal(isFresh('999000', now, 5000), true); // 1000ms old, within the window
  assert.equal(isFresh(`  ${now}  `, now, 5000), true); // just stamped (whitespace tolerated)
  assert.equal(isFresh(String(now + 1000), now, 5000), true); // a future stamp still counts as fresh

  assert.equal(isFresh('990000', now, 5000), false); // 10000ms old, past the window
  assert.equal(isFresh('', now, 5000), false); // empty
  assert.equal(isFresh('not-a-number', now, 5000), false); // garbage
  assert.equal(isFresh('0', now, 5000), false); // zero is not a real stamp
});
