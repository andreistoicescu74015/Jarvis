import { test } from 'node:test';
import assert from 'node:assert/strict';

// Genesis smoke test: proves the toolchain (node:test) and CI run green before any
// application code exists. It is replaced by real tests as the core is built.
test('smoke: test harness runs', () => {
  assert.ok(true);
});
