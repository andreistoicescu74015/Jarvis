import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerResolver } from '../src/core/owner.js';

test('owner: an env-configured owner matches via the comparator', () => {
  const r = createOwnerResolver({ owner: 'boss@x' });
  assert.equal(r.fromEnv, true);
  assert.equal(r.current, 'boss@x');
  assert.equal(r.isOwner('boss@x'), true);
  assert.equal(r.isOwner('boss:2@x'), true); // device suffix tolerated (sameUser)
  assert.equal(r.isOwner('rando@x'), false);
  assert.equal(r.isOwner(''), false);
});

test('owner: first-claimer takes ownership when none is configured', () => {
  const r = createOwnerResolver();
  assert.equal(r.fromEnv, false);
  assert.equal(r.current, '');
  assert.equal(r.isOwner('alice'), false); // nobody is owner yet
  assert.equal(r.claimIfUnset('alice'), true); // alice claims
  assert.equal(r.current, 'alice');
  assert.equal(r.isOwner('alice'), true);
  assert.equal(r.claimIfUnset('bob'), false); // already claimed -> bob is not the owner
  assert.equal(r.isOwner('bob'), false);
});

test('owner: identity match is injectable (e.g. LID<->PN bridging)', () => {
  const bridge = (a, b) => a === b || (a === 'lid' && b === 'pn') || (a === 'pn' && b === 'lid');
  const r = createOwnerResolver({ owner: 'pn', match: bridge });
  assert.equal(r.isOwner('lid'), true); // sender appears as a LID, owner set as a PN
  assert.equal(r.isOwner('other'), false);
});
