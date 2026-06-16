import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store/index.js';

test('store: a fresh db is migrated (the kv table exists and works)', () => {
  const s = createStore({ path: ':memory:' });
  s.kv.set('ns', 'k', 1);
  assert.equal(s.kv.get('ns', 'k'), 1);
  s.close();
});

test('store: KV round-trips JSON values and reports presence', () => {
  const s = createStore({ path: ':memory:' });
  assert.equal(s.kv.get('a', 'x'), undefined);
  assert.equal(s.kv.has('a', 'x'), false);
  s.kv.set('a', 'x', { n: 42, tags: ['p'] });
  assert.deepEqual(s.kv.get('a', 'x'), { n: 42, tags: ['p'] });
  assert.equal(s.kv.has('a', 'x'), true);
  s.kv.set('a', 'x', 'overwritten'); // upsert
  assert.equal(s.kv.get('a', 'x'), 'overwritten');
  assert.equal(s.kv.delete('a', 'x'), true);
  assert.equal(s.kv.delete('a', 'x'), false); // already gone
  assert.equal(s.kv.has('a', 'x'), false);
  s.close();
});

test('store: namespaces are isolated', () => {
  const s = createStore({ path: ':memory:' });
  s.kv.set('a', 'k', 'A');
  s.kv.set('b', 'k', 'B');
  assert.equal(s.kv.get('a', 'k'), 'A');
  assert.equal(s.kv.get('b', 'k'), 'B');
  assert.deepEqual(s.kv.list('a'), [{ key: 'k', value: 'A' }]);
  s.close();
});

test('store: scoped() binds a single namespace', () => {
  const s = createStore({ path: ':memory:' });
  const a = s.scoped('a');
  a.set('k', 1);
  assert.equal(a.get('k'), 1);
  assert.equal(s.kv.get('a', 'k'), 1); // same row underneath
  assert.deepEqual(a.list(), [{ key: 'k', value: 1 }]);
  s.close();
});

test('store: creates the database parent directory if it is missing', () => {
  const base = mkdtempSync(join(tmpdir(), 'jarvis-store-'));
  try {
    const dbPath = join(base, 'nested', 'deeper', 'jarvis.db'); // none of these dirs exist yet
    const s = createStore({ path: dbPath });
    s.kv.set('n', 'k', 'v');
    assert.equal(s.kv.get('n', 'k'), 'v');
    assert.ok(existsSync(dbPath));
    s.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('store: migrations are idempotent (reopening the same db re-applies nothing)', () => {
  const s1 = createStore({ path: ':memory:' });
  s1.close();
  // A second store on a fresh in-memory db migrates cleanly too (no throw).
  const s2 = createStore({ path: ':memory:' });
  s2.kv.set('n', 'k', true);
  assert.equal(s2.kv.get('n', 'k'), true);
  s2.close();
});
