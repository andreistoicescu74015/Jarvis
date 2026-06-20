import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createLinks } from '../src/core/links.js';

/** A links engine over a fresh store; every group is active unless listed in `inactive`. */
function setup(inactive = []) {
  const store = createStore({ path: ':memory:' });
  let n = 0;
  const links = createLinks(store, {
    isActivated: (id) => !inactive.includes(id),
    clearNamespace: (ns) => store.clearNamespace(ns),
    genCode: () => `C${++n}`, // deterministic, uppercase (like the real generator)
  });
  return { store, links };
}

/** Link a and b by running propose(a) then accept(code, b). */
const link = (links, a, b) => links.accept(links.propose(a), b);

test('links: a solo group resolves to its own ns and lists only itself', () => {
  const { links } = setup();
  assert.equal(links.nsFor('A', 'own:A'), 'own:A');
  assert.deepEqual(links.chats('A'), ['A']);
});

test('links: accept joins two groups into one shared overlay (covering, not merging)', () => {
  const { store, links } = setup();
  store.scoped('own:A').set('note', 'a-secret'); // each group has its own data up front
  store.scoped('own:B').set('note', 'b-secret');
  assert.equal(link(links, 'A', 'B').ok, true);
  const nsA = links.nsFor('A', 'own:A');
  const nsB = links.nsFor('B', 'own:B');
  assert.equal(nsA, nsB); // one shared overlay...
  assert.notEqual(nsA, 'own:A'); // ...distinct from either own ns
  assert.equal(store.scoped(nsA).get('note'), undefined); // overlay starts EMPTY - own data is covered, not merged
  assert.deepEqual(links.chats('A').sort(), ['A', 'B']);
});

test('links: unlinking returns a group to its own (untouched) data', () => {
  const { store, links } = setup();
  store.scoped('own:A').set('note', 'a-secret');
  link(links, 'A', 'B');
  store.scoped(links.nsFor('A', 'own:A')).set('shared', 'hello'); // write to the overlay while linked
  assert.equal(links.unlink('A').ok, true);
  assert.equal(links.nsFor('A', 'own:A'), 'own:A'); // back to its own ns
  assert.equal(store.scoped('own:A').get('note'), 'a-secret'); // own data was never touched
});

test('links: a third group joins transitively - one overlay for all', () => {
  const { links } = setup();
  link(links, 'A', 'B');
  link(links, 'B', 'C'); // C joins via B
  const ns = links.nsFor('A', 'own:A');
  assert.equal(links.nsFor('C', 'own:C'), ns);
  assert.deepEqual(links.chats('A').sort(), ['A', 'B', 'C']);
});

test('links: a redundant link inside one overlay is accepted (connectivity insurance)', () => {
  const { links } = setup();
  link(links, 'A', 'B');
  link(links, 'B', 'C'); // chain A-B-C
  const r = link(links, 'A', 'C'); // already one overlay -> a redundant edge, not a refusal
  assert.equal(r.ok, true);
  assert.equal(r.redundant, true);
});

test('links: leaving a still-connected overlay keeps it for the rest', () => {
  const { links } = setup();
  link(links, 'A', 'B');
  link(links, 'B', 'C'); // chain A-B-C
  links.unlink('A'); // A is a leaf - B and C stay linked
  assert.deepEqual(links.chats('B').sort(), ['B', 'C']);
  assert.equal(links.nsFor('B', 'own:B'), links.nsFor('C', 'own:C'));
  assert.deepEqual(links.chats('A'), ['A']); // A is solo again
});

test('links: removing a cut-vertex dissolves the whole overlay (everyone reverts to own)', () => {
  const { store, links } = setup();
  link(links, 'A', 'B');
  link(links, 'B', 'C'); // chain A-B-C; B connects A and C
  const overlayNs = links.nsFor('A', 'own:A');
  store.scoped(overlayNs).set('shared', 'data');
  links.unlink('B'); // removing B disconnects A from C -> dissolve
  assert.deepEqual(links.chats('A'), ['A']);
  assert.deepEqual(links.chats('B'), ['B']);
  assert.deepEqual(links.chats('C'), ['C']);
  assert.equal(store.scoped(overlayNs).get('shared'), undefined); // shared data discarded on dissolve
});

test('links: a redundant edge keeps the rest connected when a cut-vertex leaves', () => {
  const { links } = setup();
  link(links, 'A', 'B');
  link(links, 'B', 'C');
  link(links, 'A', 'C'); // triangle - B is no longer a cut-vertex
  links.unlink('B'); // A and C stay connected via the A-C edge
  assert.deepEqual(links.chats('A').sort(), ['A', 'C']);
});

test('links: two groups already in different overlays cannot be linked', () => {
  const { links } = setup();
  link(links, 'A', 'B'); // overlay 1
  link(links, 'C', 'D'); // overlay 2
  assert.deepEqual(link(links, 'A', 'C'), { ok: false, reason: 'both-linked' });
});

test('links: both groups must be active to link', () => {
  const { links } = setup(['B']); // B is inactive
  assert.deepEqual(link(links, 'A', 'B'), { ok: false, reason: 'inactive' });
});

test('links: bad code, self-link, and an expired code are refused', () => {
  const store = createStore({ path: ':memory:' });
  let t = 0;
  const links = createLinks(store, { now: () => t, genCode: () => 'CODE' });
  assert.deepEqual(links.accept('nope', 'B'), { ok: false, reason: 'bad-code' });
  assert.equal(links.accept(links.propose('A'), 'A').reason, 'same-chat');
  const code = links.propose('A');
  t = 11 * 60 * 1000; // past the 10-minute TTL
  assert.deepEqual(links.accept(code, 'B'), { ok: false, reason: 'expired' });
});

test('links: codes are matched case-insensitively', () => {
  const store = createStore({ path: ':memory:' });
  const links = createLinks(store, { genCode: () => 'ABC123' });
  assert.equal(links.accept(links.propose('A').toLowerCase(), 'B').ok, true);
});

test('links: unlinking a solo group is a no-op', () => {
  const { links } = setup();
  assert.deepEqual(links.unlink('A'), { ok: false, reason: 'not-linked' });
});

test('links: a code is one-time - spent even by a refused attempt (no replay)', () => {
  const { links } = setup();
  link(links, 'A', 'B'); // overlay 1
  link(links, 'C', 'D'); // overlay 2
  const code = links.propose('A');
  assert.equal(links.accept(code, 'C').reason, 'both-linked'); // refused (two overlays), but the code is spent
  links.unlink('C'); // C is solo again
  assert.equal(links.accept(code, 'C').reason, 'bad-code'); // the spent code cannot be replayed
});
