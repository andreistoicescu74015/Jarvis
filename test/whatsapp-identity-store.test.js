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
  id.learnFromKey({ participant: LID, participantAlt: PN }); // real rc13 inbound key: participant + participantAlt
  assert.equal(id.pnForLid(LID), PN);
  assert.equal(id.lidForPn(PN), LID);
  assert.equal(id.same(LID, PN), true); // bridged both ways
  assert.equal(id.same(PN, LID), true);
  store.close();
});

test('identity: learnFromKey also accepts the legacy participantPn field defensively', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learnFromKey({ participant: LID, participantPn: PN });
  assert.equal(id.same(LID, PN), true);
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

test('identity: a conflicting pair seen consistently across days SELF-HEALS the mapping', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN); // the original pairing
  const NEW_PN = '40799@s.whatsapp.net'; // the person moved to a new number
  id.learn(LID, NEW_PN); // sighting 1 (day 1) - refused
  id.learn(LID, NEW_PN); // sighting 2 (day 1) - still refused (same day)
  assert.equal(id.pnForLid(LID), PN); // nothing changed yet
  t = new Date('2026-07-05T09:00:00').getTime();
  id.learn(LID, NEW_PN); // sighting 3, on a DIFFERENT day -> heals
  assert.equal(id.pnForLid(LID), NEW_PN); // remapped to the persistent new pair
  assert.equal(id.lidForPn(NEW_PN), LID);
  assert.equal(id.lidForPn(PN), undefined); // the stale reverse mapping is gone
  assert.equal(id.same(LID, NEW_PN), true);
  store.close();
});

test('identity: repeated conflicts within ONE day never heal (a spoofing burst cannot flip identity)', () => {
  const store = createStore({ path: ':memory:' });
  const t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  for (let i = 0; i < 10; i++) id.learn(LID, '40799@s.whatsapp.net'); // hammered, same day
  assert.equal(id.pnForLid(LID), PN); // first-learned mapping holds
  store.close();
});

test('identity: a different conflicting candidate starts its own counter (no cross-crediting)', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  id.learn(LID, '40788@s.whatsapp.net'); // candidate A, sighting 1
  id.learn(LID, '40799@s.whatsapp.net'); // candidate B, sighting 1
  t = new Date('2026-07-05T09:00:00').getTime();
  id.learn(LID, '40799@s.whatsapp.net'); // candidate B, sighting 2 (day 2) - still under the bar of 3
  assert.equal(id.pnForLid(LID), PN); // neither candidate healed
  store.close();
});

test('identity: forget drops both directions and pending conflicts; the pair re-learns fresh', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learn(LID, PN);
  id.learn(LID, '40799@s.whatsapp.net'); // leaves a pending conflict counter too
  assert.equal(id.forget(PN), true); // by either id form
  assert.equal(id.pnForLid(LID), undefined);
  assert.equal(id.lidForPn(PN), undefined);
  assert.equal(store.scoped('wa-identity').list().length, 0); // conflict counters swept as well
  id.learn(LID, '40799@s.whatsapp.net'); // fresh learn of the new pair - no stale mapping in the way
  assert.equal(id.pnForLid(LID), '40799@s.whatsapp.net');
  assert.equal(id.forget('unknown@lid'), false); // nothing stored -> false
  store.close();
});
