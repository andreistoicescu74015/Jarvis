import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInbound } from '../src/whatsapp/normalize.js';

const PRIVATE = '1234@s.whatsapp.net';
const GROUP = '111-222@g.us';

test('normalize: a private text message maps to the inbound shape', () => {
  const inbound = toInbound({
    key: { remoteJid: PRIVATE, fromMe: false },
    message: { conversation: 'jarvis ping' },
  });
  assert.deepEqual(inbound, {
    kind: 'message',
    text: 'jarvis ping',
    chatId: PRIVATE,
    sender: PRIVATE,
    level: 'private',
    fromMe: false,
    isAdmin: false,
    mentionedJid: [],
    raw: inbound.raw,
  });
});

test('normalize: a group message resolves level and admin from metadata', () => {
  const groupMetadata = {
    participants: [
      { id: '9@s.whatsapp.net', admin: 'admin' },
      { id: '8@s.whatsapp.net', admin: null },
    ],
  };
  const admin = toInbound(
    { key: { remoteJid: GROUP, participant: '9:3@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' } },
    { groupMetadata },
  );
  assert.equal(admin.level, 'group');
  assert.equal(admin.sender, '9@s.whatsapp.net'); // device suffix dropped
  assert.equal(admin.isAdmin, true);

  const member = toInbound(
    { key: { remoteJid: GROUP, participant: '8@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' } },
    { groupMetadata },
  );
  assert.equal(member.isAdmin, false);
});

test('normalize: a community is detected from group metadata flags', () => {
  const inbound = toInbound(
    { key: { remoteJid: GROUP, participant: '9@s.whatsapp.net' }, message: { conversation: 'hi' } },
    { groupMetadata: { isCommunity: true, participants: [] } },
  );
  assert.equal(inbound.level, 'community');
  assert.equal(inbound.community, GROUP); // an announcement group is its own community id
});

test('normalize: a sub-group carries its parent community id', () => {
  const inbound = toInbound(
    { key: { remoteJid: GROUP, participant: '9@s.whatsapp.net' }, message: { conversation: 'hi' } },
    { groupMetadata: { linkedParent: 'c@g.us', participants: [] } },
  );
  assert.equal(inbound.level, 'community');
  assert.equal(inbound.community, 'c@g.us'); // points at the parent community
});

test('normalize: a plain group carries no community id', () => {
  const inbound = toInbound(
    { key: { remoteJid: GROUP, participant: '9@s.whatsapp.net' }, message: { conversation: 'hi' } },
    { groupMetadata: { participants: [] } },
  );
  assert.equal(inbound.level, 'group');
  assert.equal('community' in inbound, false); // field omitted, not undefined
});

test('normalize: extended text carries mentions; ephemeral wrappers are unwrapped', () => {
  const mention = toInbound({
    key: { remoteJid: PRIVATE },
    message: {
      extendedTextMessage: { text: '@1234 ping', contextInfo: { mentionedJid: [PRIVATE] } },
    },
  });
  assert.equal(mention.text, '@1234 ping');
  assert.deepEqual(mention.mentionedJid, [PRIVATE]);

  const ephemeral = toInbound({
    key: { remoteJid: PRIVATE },
    message: { ephemeralMessage: { message: { conversation: 'hi' } } },
  });
  assert.equal(ephemeral.text, 'hi');
});

test('normalize: a media caption becomes the text', () => {
  const inbound = toInbound({
    key: { remoteJid: PRIVATE },
    message: { imageMessage: { caption: 'jarvis note add milk' } },
  });
  assert.equal(inbound.text, 'jarvis note add milk');
});

test('normalize: a document caption carries its text AND its @mentions', () => {
  const inbound = toInbound(
    { key: { remoteJid: GROUP, participant: '9@s.whatsapp.net' }, message: { documentMessage: { caption: 'jarvis ping', contextInfo: { mentionedJid: ['9@s.whatsapp.net'] } } } },
    { groupMetadata: { participants: [] } },
  );
  assert.equal(inbound.text, 'jarvis ping');
  assert.deepEqual(inbound.mentionedJid, ['9@s.whatsapp.net']); // document contextInfo is now read (was missed before)
});

test('normalize: fromMe is preserved (the app loop is what drops it)', () => {
  const inbound = toInbound({ key: { remoteJid: PRIVATE, fromMe: true }, message: { conversation: 'x' } });
  assert.equal(inbound.fromMe, true);
});

test('normalize: returns null when there is no text and no remoteJid', () => {
  assert.equal(toInbound({ key: { remoteJid: PRIVATE }, message: { reactionMessage: { text: '👍' } } }), null);
  assert.equal(toInbound({ key: {}, message: { conversation: 'hi' } }), null);
  assert.equal(toInbound({}), null);
});
