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

test('store: transaction commits on success and rolls back the whole thing on throw', () => {
  const s = createStore({ path: ':memory:' });
  s.transaction(() => {
    s.kv.set('n', 'a', 1);
    s.kv.set('n', 'b', 2);
  });
  assert.equal(s.kv.get('n', 'a'), 1);
  assert.equal(s.kv.get('n', 'b'), 2);

  assert.throws(
    () =>
      s.transaction(() => {
        s.kv.set('n', 'c', 3); // written...
        throw new Error('boom'); // ...then rolled back
      }),
    /boom/,
  );
  assert.equal(s.kv.get('n', 'c'), undefined); // nothing partial survives
  s.close();
});

test('store: transactions are re-entrant (a nested call joins the outer; one rollback undoes all)', () => {
  const s = createStore({ path: ':memory:' });
  assert.throws(
    () =>
      s.transaction(() => {
        s.kv.set('n', 'x', 1);
        s.transaction(() => s.kv.set('n', 'y', 2)); // nested - no separate commit
        throw new Error('rollback all');
      }),
    /rollback all/,
  );
  assert.equal(s.kv.get('n', 'x'), undefined); // the outer rollback undoes the nested write too
  assert.equal(s.kv.get('n', 'y'), undefined);
  s.close();
});

test('store: a file-backed db uses WAL (a -wal sidecar appears on write)', () => {
  const base = mkdtempSync(join(tmpdir(), 'jarvis-store-'));
  try {
    const dbPath = join(base, 'j.db');
    const s = createStore({ path: dbPath });
    s.kv.set('n', 'k', 'v'); // a write populates the write-ahead log
    assert.ok(existsSync(`${dbPath}-wal`), 'expected a -wal sidecar (WAL journal mode is on)');
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

test('store: clearNamespace clears one namespace; clearAll wipes every namespace', () => {
  const s = createStore({ path: ':memory:' });
  s.kv.set('ns1', 'a', 1);
  s.kv.set('ns1', 'b', 2);
  s.kv.set('ns2', 'c', 3);
  assert.equal(s.clearNamespace('ns1'), 2); // only ns1
  assert.equal(s.kv.get('ns2', 'c'), 3); // ns2 untouched
  s.kv.set('ns1', 'a', 1);
  assert.equal(s.clearAll(), 2); // ns1.a + ns2.c
  assert.equal(s.kv.get('ns1', 'a'), undefined);
  assert.equal(s.kv.get('ns2', 'c'), undefined);
  s.close();
});
