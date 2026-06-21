import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCommunity, toSubGroups } from '../src/whatsapp/community.js';

test('community: toSubGroups shapes linked groups, keeps sizes, drops id-less entries', () => {
  const linked = {
    communityJid: 'c@g.us',
    isCommunity: true,
    linkedGroups: [
      { id: 'a@g.us', subject: 'Alpha', size: 412 },
      { id: 'b@g.us', subject: '', size: 88 }, // empty subject -> id becomes the name
      { subject: 'no id' }, // no id -> dropped
    ],
  };
  assert.deepEqual(toSubGroups(linked), [
    { id: 'a@g.us', name: 'Alpha', size: 412 },
    { id: 'b@g.us', name: 'b@g.us', size: 88 },
  ]);
});

test('community: toSubGroups tolerates a missing or empty payload', () => {
  assert.deepEqual(toSubGroups(undefined), []);
  assert.deepEqual(toSubGroups({}), []);
  assert.deepEqual(toSubGroups({ linkedGroups: [] }), []);
});

test('community: toSubGroups omits size when WhatsApp does not report it', () => {
  assert.deepEqual(toSubGroups({ linkedGroups: [{ id: 'a@g.us', subject: 'Alpha' }] }), [
    { id: 'a@g.us', name: 'Alpha' },
  ]);
});

test('community: toCommunity merges metadata with linked groups', () => {
  const meta = { id: 'c@g.us', subject: 'Anul 2', desc: 'Info hub', size: 501 };
  const linked = { linkedGroups: [{ id: 's@g.us', subject: 'General', size: 412 }] };
  assert.deepEqual(toCommunity(meta, linked), {
    id: 'c@g.us',
    name: 'Anul 2',
    description: 'Info hub',
    subGroups: [{ id: 's@g.us', name: 'General', size: 412 }],
    reach: 501,
  });
});

test('community: toCommunity falls back to participant count for reach and omits an empty description', () => {
  const community = toCommunity({ id: 'c@g.us', subject: 'Anul 2', participants: [{}, {}, {}] }, undefined);
  assert.equal(community.reach, 3); // no size -> participants.length
  assert.equal('description' in community, false); // no desc -> field omitted
  assert.deepEqual(community.subGroups, []);
});

test('community: toCommunity returns undefined without a usable id', () => {
  assert.equal(toCommunity(undefined, undefined), undefined);
  assert.equal(toCommunity({ subject: 'no id' }, undefined), undefined);
});
