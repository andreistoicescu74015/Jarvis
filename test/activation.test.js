import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';

test('activation: a chat is inactive until activated, then active; deactivate reverses it', () => {
  const store = createStore({ path: ':memory:' });
  const act = createActivation(store, { now: () => 1000 });

  assert.equal(act.isActive('g1@g.us'), false);
  assert.equal(act.activate('g1@g.us', 'boss'), true); // newly activated
  assert.equal(act.isActive('g1@g.us'), true);
  assert.equal(act.activate('g1@g.us', 'boss'), false); // idempotent: already active
  assert.deepEqual(act.list(), ['g1@g.us']);

  assert.equal(act.deactivate('g1@g.us'), true);
  assert.equal(act.isActive('g1@g.us'), false);
  assert.equal(act.deactivate('g1@g.us'), false); // was not active
  assert.deepEqual(act.list(), []);
  store.close();
});

test('activation: persists in the store (a fresh view sees prior activations)', () => {
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('g@g.us', 'boss');
  const reopened = createActivation(store); // a new view over the same store
  assert.equal(reopened.isActive('g@g.us'), true);
  assert.deepEqual(reopened.list(), ['g@g.us']);
  store.close();
});
