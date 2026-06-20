import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createIdentityStore } from '../src/whatsapp/identity-store.js';

const LID = '111@lid';
const PN = '40712@s.whatsapp.net';

test('identity: learns a LID<->PN pair from a group message key and bridges them', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  assert.equal(id.same(LID, PN), false); // unknown before learning
  id.learnFromKey({ participant: LID, participantPn: PN });
  assert.equal(id.pnForLid(LID), PN);
  assert.equal(id.lidForPn(PN), LID);
  assert.equal(id.same(LID, PN), true); // bridged both ways
  assert.equal(id.same(PN, LID), true);
  store.close();
});

test('identity: same() keeps plain matching and never collides across id spaces', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  assert.equal(id.same(PN, '40712:4@s.whatsapp.net'), true); // device suffix, same PN
  assert.equal(id.same(LID, '222@lid'), false); // different LIDs
  assert.equal(id.same(LID, PN), false); // not learned -> spaces don't collide
  store.close();
});

test('identity: learned pairs persist across instances', () => {
  const store = createStore({ path: ':memory:' });
  createIdentityStore(store).learn(LID, PN);
  const id2 = createIdentityStore(store); // new instance, same store
  assert.equal(id2.same(LID, PN), true);
  store.close();
});

test('identity: refuses a conflicting pairing (keeps the first-learned, never silently remaps)', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learn(LID, PN); // LID <-> 40712
  id.learn(LID, '40799@s.whatsapp.net'); // same LID, different PN -> conflict, refused
  assert.equal(id.pnForLid(LID), PN); // unchanged
  id.learn('222@lid', PN); // same PN, different LID -> conflict, refused
  assert.equal(id.lidForPn(PN), LID); // unchanged
  store.close();
});

test('identity: re-learning the same pair is a harmless no-op (not a conflict)', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learn(LID, PN);
  id.learn(PN, LID); // same pair, reversed order
  assert.equal(id.pnForLid(LID), PN);
  assert.equal(id.lidForPn(PN), LID);
  store.close();
});

test('identity: learnFromKey ignores keys without both id forms', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learnFromKey({ participant: PN }); // only a PN
  id.learnFromKey({ participant: LID }); // only a LID
  id.learnFromKey(null);
  assert.equal(id.pnForLid(LID), undefined);
  store.close();
});
