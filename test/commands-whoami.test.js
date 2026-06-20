import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import whoami from '../src/commands/whoami.js';

const handle = (over = {}, opts = {}) => {
  const dispatch = createDispatcher(createRegistry([whoami]), opts);
  return dispatch({ text: 'jarvis whoami', sender: 'x', level: 'private', ...over }).then(toPlain);
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
  const out = await handle({ sender: 'boss', level: 'group', isAdmin: true }, { owner: 'boss' });
  assert.match(out, /\(owner, admin\)/);
});
