import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import whoami from '../src/commands/whoami.js';

// whoami is owner-only, so these self-identity checks make the sender the owner.
const handle = (over = {}, opts = {}) => {
  const sender = over.sender ?? 'boss';
  const dispatch = createDispatcher(createRegistry([whoami]), { owner: sender, ...opts });
  return dispatch({ text: 'jarvis whoami', sender, level: 'private', ...over }).then(toPlain);
};

test('whoami: shows a phone number for a WhatsApp user, not a raw jid', async () => {
  const out = await handle({ sender: '40712345678@s.whatsapp.net', level: 'group' });
  assert.match(out, /You are \+40712345678 in a group chat/);
  assert.doesNotMatch(out, /@s\.whatsapp\.net/);
});

test('whoami: shows the bare id for a LID, and the raw value when already friendly', async () => {
  assert.match(await handle({ sender: '5678@lid' }), /You are 5678 in a private chat/);
  assert.match(await handle({ sender: 'cli-user' }), /You are cli-user in a private chat/);
});

test('whoami: tags the owner and admin flags', async () => {
  const out = await handle({ sender: 'boss', level: 'group', isAdmin: true });
  assert.match(out, /\(owner, admin\)/);
});

test('whoami: the owner looks a person up by number (resolved to the canonical id)', async () => {
  const resolveUser = (t) => {
    const d = String(t).replace(/[^0-9]/g, '');
    return d ? `${d}@s.whatsapp.net` : String(t);
  };
  const dispatch = createDispatcher(createRegistry([whoami]), { owner: 'boss', resolveUser });
  const out = toPlain(await dispatch({ text: 'jarvis whoami 40712345678', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /\+40712345678/); // friendly form
  assert.match(out, /40712345678@s\.whatsapp\.net/); // the canonical id to whitelist
});

test('whoami: the owner looks a person up by @mention', async () => {
  const dispatch = createDispatcher(createRegistry([whoami]), { owner: 'boss' });
  const out = toPlain(await dispatch({ text: 'jarvis whoami @x', sender: 'boss', level: 'group', mentionedJid: ['55@s.whatsapp.net'] }));
  assert.match(out, /55@s\.whatsapp\.net/);
});

test('whoami: is owner-only - a non-owner is not allowed', async () => {
  const dispatch = createDispatcher(createRegistry([whoami]), { owner: 'boss' });
  const out = await dispatch({ text: 'jarvis whoami', sender: 'rando', level: 'private', chatId: 'dm' });
  assert.match(out, /Not allowed: owner only/);
});
