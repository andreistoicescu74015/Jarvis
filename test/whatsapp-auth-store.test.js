import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createSqliteAuthState } from '../src/whatsapp/auth-store.js';

test('auth-store: fresh creds are generated and persist across instances', () => {
  const store = createStore({ path: ':memory:' });
  const a = createSqliteAuthState(store);
  assert.ok(a.state.creds?.noiseKey); // initAuthCreds populated it
  a.saveCreds();

  const b = createSqliteAuthState(store); // new instance, same db
  assert.deepEqual(b.state.creds.noiseKey, a.state.creds.noiseKey); // round-tripped, Buffers intact
  store.close();
});

test('auth-store: signal keys round-trip (Buffers survive) and delete works', async () => {
  const store = createStore({ path: ':memory:' });
  const a = createSqliteAuthState(store);
  const value = { keyPair: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } };
  await a.state.keys.set({ 'pre-key': { '1': value } });

  const b = createSqliteAuthState(store);
  const got = await b.state.keys.get('pre-key', ['1']);
  assert.ok(Buffer.isBuffer(got['1'].keyPair.public));
  assert.deepEqual([...got['1'].keyPair.public], [1, 2, 3]);

  await b.state.keys.set({ 'pre-key': { '1': null } }); // null deletes
  const c = createSqliteAuthState(store);
  const gone = await c.state.keys.get('pre-key', ['1']);
  assert.equal(gone['1'], undefined);
  store.close();
});

test('auth-store: clear() wipes the persisted namespace', () => {
  const store = createStore({ path: ':memory:' });
  const a = createSqliteAuthState(store);
  a.saveCreds();
  assert.ok(store.scoped('wa-auth').list().length > 0);
  a.clear();
  assert.equal(store.scoped('wa-auth').list().length, 0);
  store.close();
});
