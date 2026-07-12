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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('identity: a conflicting pair seen consistently across a full day SELF-HEALS the mapping', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN); // the original pairing
  const NEW_PN = '40799@s.whatsapp.net'; // the person moved to a new number
  id.learn(LID, NEW_PN); // sighting 1 - refused
  t += 2 * HOUR;
  id.learn(LID, NEW_PN); // sighting 2 - still refused (not a day of spread yet)
  assert.equal(id.pnForLid(LID), PN); // nothing changed yet
  t += 25 * HOUR; // sighting 3, more than 24h of ELAPSED time after the first -> heals
  id.learn(LID, NEW_PN);
  assert.equal(id.pnForLid(LID), NEW_PN); // remapped to the persistent new pair
  assert.equal(id.lidForPn(NEW_PN), LID);
  assert.equal(id.lidForPn(PN), undefined); // the stale reverse mapping is gone
  assert.equal(id.same(LID, NEW_PN), true);
  store.close();
});

test('identity: repeated conflicts within one day never heal (a spoofing burst cannot flip identity)', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  for (let i = 0; i < 10; i++) { t += 30 * 60 * 1000; id.learn(LID, '40799@s.whatsapp.net'); } // hammered for 5h
  assert.equal(id.pnForLid(LID), PN); // first-learned mapping holds
  store.close();
});

test('identity: a burst straddling midnight still never heals (elapsed time, not calendar labels)', () => {
  // 23:58 + 23:59 + 00:01 is three sightings on "two days" but ~3 minutes of real time - the bar
  // measures elapsed spread, so a midnight-crossing burst cannot flip identity.
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T23:58:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  id.learn(LID, '40799@s.whatsapp.net'); // 23:58
  t += 60 * 1000;
  id.learn(LID, '40799@s.whatsapp.net'); // 23:59
  t += 2 * 60 * 1000;
  id.learn(LID, '40799@s.whatsapp.net'); // 00:01, "next day"
  assert.equal(id.pnForLid(LID), PN); // holds - 3 minutes is not persistence
  store.close();
});

test('identity: stale sightings do not accumulate - an idle counter starts over', () => {
  // Two one-off conflicts, then months of silence: a third sighting long after must NOT complete
  // the bar (the old counter is out of the freshness window and resets).
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  id.learn(LID, '40799@s.whatsapp.net'); // sighting 1
  t += 26 * HOUR;
  id.learn(LID, '40799@s.whatsapp.net'); // sighting 2, a day later (spread satisfied, count not yet)
  t += 90 * DAY; // months of silence - the counter went stale
  id.learn(LID, '40799@s.whatsapp.net'); // NOT sighting 3: the counter restarted at 1
  assert.equal(id.pnForLid(LID), PN); // no heal from stale evidence
  store.close();
});

test('identity: a different conflicting candidate starts its own counter (no cross-crediting)', () => {
  const store = createStore({ path: ':memory:' });
  let t = new Date('2026-07-04T10:00:00').getTime();
  const id = createIdentityStore(store, { now: () => t });
  id.learn(LID, PN);
  id.learn(LID, '40788@s.whatsapp.net'); // candidate A, sighting 1
  id.learn(LID, '40799@s.whatsapp.net'); // candidate B, sighting 1
  t += 25 * HOUR;
  id.learn(LID, '40799@s.whatsapp.net'); // candidate B, sighting 2 (a day later) - still under the bar of 3
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

test('identity: forget matches conflict counters by exact id, never by substring', () => {
  // +47 55 55 12 34 is a strict SUFFIX of +1 475 555 1234: forgetting the Norwegian number must
  // not delete the American user's in-progress heal counter (or report a false success).
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store, { now: () => new Date('2026-07-04T10:00:00').getTime() });
  id.learn('222@lid', '14755551234@s.whatsapp.net'); // the US user's mapping
  id.learn('333@lid', '14755551234@s.whatsapp.net'); // a pending counter NAMING the US number
  assert.equal(id.forget('4755551234@s.whatsapp.net'), false); // nothing stored about the NO number
  assert.equal(id.pnForLid('222@lid'), '14755551234@s.whatsapp.net'); // mapping untouched
  const counters = store.scoped('wa-identity').list().filter((e) => e.key.startsWith('conflict:'));
  assert.equal(counters.length, 1); // the US user's heal progress survived the suffix collision
  store.close();
});

test('identity: learnFromKey harvests a DM key (remoteJid + remoteJidAlt) too', () => {
  // v7 DM keys carry the sender as the chat jid plus its alternate form - without harvesting them,
  // a DM-only owner whose chat flips addressing mode (LID migration) could never re-teach the
  // bridge and would silently stop matching as owner.
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learnFromKey({ remoteJid: PN, remoteJidAlt: LID }); // a DM: no participant fields
  assert.equal(id.same(LID, PN), true);
  store.close();
});

test('identity: learnFromKey never treats a group jid as a person', () => {
  const store = createStore({ path: ':memory:' });
  const id = createIdentityStore(store);
  id.learnFromKey({ remoteJid: 'g1@g.us', participant: LID }); // group key: only participant fields count
  assert.equal(id.pnForLid(LID), undefined); // nothing learned (no PN in the key)
  store.close();
});
