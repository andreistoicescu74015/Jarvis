import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mentionsBot,
  startsWithPrefix,
  stripBotMention,
  resolveAddressing,
} from '../src/whatsapp/trigger.js';

const SELF = '1234@s.whatsapp.net';

test('trigger: mentionsBot matches the bot LID-aware, ignores absence/empty self', () => {
  assert.equal(mentionsBot([SELF], '1234:7@s.whatsapp.net'), true); // device suffix tolerated
  assert.equal(mentionsBot(['9@s.whatsapp.net'], SELF), false);
  assert.equal(mentionsBot([], SELF), false);
  assert.equal(mentionsBot([SELF], ''), false);
  assert.equal(mentionsBot(undefined, SELF), false);
});

test('trigger: startsWithPrefix is case-insensitive and exact-or-space', () => {
  assert.equal(startsWithPrefix('jarvis ping', 'jarvis'), true);
  assert.equal(startsWithPrefix('JARVIS', 'jarvis'), true);
  assert.equal(startsWithPrefix('jarvisx ping', 'jarvis'), false);
  assert.equal(startsWithPrefix('hello', 'jarvis'), false);
});

test('trigger: stripBotMention removes the bot @mention token(s)', () => {
  assert.equal(stripBotMention('@1234 ping', SELF), 'ping');
  assert.equal(stripBotMention('hey @1234 there', SELF), 'hey there');
  assert.equal(stripBotMention('@1234 ping', '1234:5@s.whatsapp.net'), 'ping'); // self has device suffix
  assert.equal(stripBotMention('no mention here', SELF), 'no mention here');
});

test('trigger: resolveAddressing - prefix path keeps text, not bare', () => {
  assert.deepEqual(resolveAddressing({ text: 'jarvis ping' }, { selfId: SELF, prefix: 'jarvis' }), {
    handle: true,
    bare: false,
    text: 'jarvis ping',
  });
});

test('trigger: resolveAddressing - mention path is bare with the mention stripped', () => {
  assert.deepEqual(
    resolveAddressing({ text: '@1234 ping', mentionedJid: [SELF] }, { selfId: SELF, prefix: 'jarvis' }),
    { handle: true, bare: true, text: 'ping' },
  );
});

test('trigger: resolveAddressing - neither prefix nor mention is not handled', () => {
  assert.deepEqual(resolveAddressing({ text: 'hello', mentionedJid: [] }, { selfId: SELF, prefix: 'jarvis' }), {
    handle: false,
    bare: false,
    text: 'hello',
  });
});

test('trigger: resolveAddressing - prefix wins even when also mentioned', () => {
  const r = resolveAddressing({ text: 'jarvis ping', mentionedJid: [SELF] }, { selfId: SELF, prefix: 'jarvis' });
  assert.equal(r.bare, false);
  assert.equal(r.text, 'jarvis ping');
});
