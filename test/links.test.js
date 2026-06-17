import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createLinks } from '../src/core/links.js';

const seed = (store, ns, obj) => {
  for (const [k, v] of Object.entries(obj)) store.kv.set(ns, k, v);
};

test('links: an unlinked chat resolves to its own ns and is alone', () => {
  const links = createLinks(createStore({ path: ':memory:' }));
  assert.equal(links.nsFor('A', 'own:A'), 'own:A');
  assert.deepEqual(links.chats('A'), ['A']);
  assert.equal(links.areLinked('A', 'B'), false);
});

test('links: linking two chats merges data into one shared context', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  seed(store, 'own:A', { notes: ['a1'] });
  seed(store, 'own:B', { reminders: ['b1'] }); // different keys -> no conflict
  assert.equal(links.link('A', 'own:A', 'B', 'own:B').ok, true);
  assert.equal(links.areLinked('A', 'B'), true);
  const ns = links.nsFor('A', 'own:A');
  assert.equal(ns, links.nsFor('B', 'own:B')); // same shared ns
  assert.deepEqual(store.kv.get(ns, 'notes'), ['a1']); // A's data
  assert.deepEqual(store.kv.get(ns, 'reminders'), ['b1']); // and B's data
  assert.deepEqual(links.chats('A').sort(), ['A', 'B']);
});

test('links: conflicting data refuses the link (no overwrite)', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  seed(store, 'own:A', { notes: ['a'] });
  seed(store, 'own:B', { notes: ['b'] }); // same key, different value
  const r = links.link('A', 'own:A', 'B', 'own:B');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.deepEqual(r.conflicts, ['notes']);
  assert.equal(links.areLinked('A', 'B'), false);
});

test('links: a third chat joins transitively - one shared context', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  links.link('A', 'own:A', 'B', 'own:B');
  assert.equal(links.link('C', 'own:C', 'A', 'own:A').ok, true); // C joins A's cluster
  assert.deepEqual(links.chats('C').sort(), ['A', 'B', 'C']);
  assert.equal(links.nsFor('C', 'own:C'), links.nsFor('B', 'own:B'));
});

test('links: merging two existing clusters keeps everyone in one context', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  links.link('A', 'own:A', 'B', 'own:B'); // cluster 1
  links.link('C', 'own:C', 'D', 'own:D'); // cluster 2
  assert.equal(links.link('A', 'own:A', 'C', 'own:C').ok, true); // merge the clusters
  assert.deepEqual(links.chats('D').sort(), ['A', 'B', 'C', 'D']);
});

test('links: re-linking chats already in the same cluster is refused', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  links.link('A', 'own:A', 'B', 'own:B');
  assert.equal(links.link('A', 'own:A', 'B', 'own:B').reason, 'already-linked');
});

test('links: unlink copies the shared data out and keeps nothing lost', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store);
  seed(store, 'own:A', { notes: ['a1'] });
  links.link('A', 'own:A', 'B', 'own:B');
  const shared = links.nsFor('A', 'own:A');
  store.kv.set(shared, 'extra', ['added-while-linked']);
  assert.equal(links.unlink('A', 'own:A').ok, true);
  assert.deepEqual(links.chats('A'), ['A']); // alone again
  assert.deepEqual(store.kv.get('own:A', 'notes'), ['a1']); // own data kept
  assert.deepEqual(store.kv.get('own:A', 'extra'), ['added-while-linked']); // plus shared additions
});

test('links: unlinking a non-linked chat is a no-op result', () => {
  const links = createLinks(createStore({ path: ':memory:' }));
  assert.equal(links.unlink('A', 'own:A').reason, 'not-linked');
});
