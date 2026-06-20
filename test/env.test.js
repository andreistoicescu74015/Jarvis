import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num } from '../src/core/env.js';

test('env.num: falls back on unset/empty/non-finite, but honors an explicit 0', () => {
  assert.equal(num(undefined, 30), 30);
  assert.equal(num(null, 30), 30);
  assert.equal(num('', 30), 30);
  assert.equal(num('abc', 30), 30);
  assert.equal(num('0', 30), 0); // explicit zero is kept, not clobbered to the fallback
  assert.equal(num('1500', 30), 1500);
});
