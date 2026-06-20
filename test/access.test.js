import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createAccessPolicy } from '../src/core/access.js';

/** A fresh policy over an in-memory store; pass a custom identity matcher if needed. */
function policy(match) {
  const store = createStore({ path: ':memory:' });
  return createAccessPolicy(store, match ? { match } : undefined);
}

test('access: public by default - everyone passes, for a command and the whole bot', () => {
  const a = policy();
  assert.equal(a.passes('note', 'g1', 'alice'), true);
  assert.equal(a.passes('*', 'g1', 'alice'), true);
});

test('access: whitelist - only listed pass; an enabled empty whitelist is owner-only (private)', () => {
  const a = policy();
  a.enable('whitelist', 'note', 'g1'); // empty + active = nobody (but the owner, who bypasses)
  assert.equal(a.passes('note', 'g1', 'alice'), false);
  a.add('whitelist', 'note', 'g1', 'alice');
  assert.equal(a.passes('note', 'g1', 'alice'), true);
  assert.equal(a.passes('note', 'g1', 'bob'), false);
});

test('access: blacklist - listed blocked, others pass; an enabled empty blacklist is open', () => {
  const a = policy();
  a.enable('blacklist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), true);
  a.add('blacklist', 'note', 'g1', 'bob');
  assert.equal(a.passes('note', 'g1', 'bob'), false);
  assert.equal(a.passes('note', 'g1', 'alice'), true);
});

test('access: "*" as a member means everyone', () => {
  const a = policy();
  a.add('blacklist', 'note', 'g1', '*');
  a.enable('blacklist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'whoever'), false);
});

test('access: add does NOT auto-enable - activation is manual', () => {
  const a = policy();
  a.add('whitelist', 'note', 'g1', 'alice'); // members set, mode still public
  assert.equal(a.passes('note', 'g1', 'bob'), true);
  a.enable('whitelist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), false);
});

test('access: disable keeps members; enable restores without re-adding', () => {
  const a = policy();
  a.add('whitelist', 'note', 'g1', 'alice');
  a.enable('whitelist', 'note', 'g1');
  a.disable('note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), true); // public again
  assert.deepEqual(a.get('note', 'g1').whitelist, ['alice']); // kept
  a.enable('whitelist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), false); // restored
});

test('access: switching the active mode is non-destructive (both lists persist)', () => {
  const a = policy();
  a.add('whitelist', 'note', 'g1', 'alice');
  a.add('blacklist', 'note', 'g1', 'bob');
  a.enable('blacklist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), false);
  a.enable('whitelist', 'note', 'g1');
  assert.deepEqual(a.get('note', 'g1').blacklist, ['bob']); // still there
  assert.equal(a.passes('note', 'g1', 'alice'), true);
});

test('access: clear empties a list and reopens the target if it was active', () => {
  const a = policy();
  a.add('whitelist', 'note', 'g1', 'alice');
  a.enable('whitelist', 'note', 'g1');
  a.clear('whitelist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'bob'), true);
  assert.deepEqual(a.get('note', 'g1').whitelist, []);
});

test('access: a rule applies only in its own context (no cross-context)', () => {
  const a = policy();
  a.add('blacklist', 'note', 'g1', 'spammer');
  a.enable('blacklist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'spammer'), false); // blocked where the rule is set
  assert.equal(a.passes('note', 'g2', 'spammer'), true); // another context is unaffected
  assert.equal(a.passes('note', 'g1', 'alice'), true);
});

test('access: the whole-bot target ("*") gates every command in its context', () => {
  const a = policy();
  a.enable('whitelist', '*', 'g1'); // private bot in g1 (only the owner, who bypasses)
  assert.equal(a.passes('*', 'g1', 'alice'), false);
  assert.equal(a.passes('*', 'g2', 'bob'), true); // a different context is unaffected
});

test('access: matching is identity-aware via the injected matcher (LID <-> PN)', () => {
  const bridged = (a, b) => a === b || a.replace(/^lid:/, '') === b.replace(/^pn:/, '');
  const a = policy(bridged);
  a.add('blacklist', 'note', 'g1', 'pn:5');
  a.enable('blacklist', 'note', 'g1');
  assert.equal(a.passes('note', 'g1', 'lid:5'), false); // same person, other id form
});

test('access: add is idempotent and remove is identity-aware', () => {
  const a = policy();
  a.add('blacklist', 'note', 'g1', 'bob');
  a.add('blacklist', 'note', 'g1', 'bob');
  assert.deepEqual(a.get('note', 'g1').blacklist, ['bob']);
  a.remove('blacklist', 'note', 'g1', 'bob');
  assert.deepEqual(a.get('note', 'g1').blacklist, []);
});

test('access: all() returns the stored rules, decoded', () => {
  const a = policy();
  a.add('whitelist', 'note', 'g1', 'alice');
  a.enable('whitelist', 'note', 'g1');
  const rules = a.all();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].target, 'note');
  assert.equal(rules[0].context, 'g1');
  assert.equal(rules[0].active, 'whitelist');
});

test('access: a JID context with no separator collisions round-trips in all()', () => {
  const a = policy();
  a.add('blacklist', 'note', '123-456@g.us', 'bob');
  const rule = a.all().find((r) => r.target === 'note');
  assert.equal(rule.context, '123-456@g.us');
});
