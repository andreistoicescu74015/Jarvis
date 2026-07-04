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

test('whoami: shows the friendly phone number AND the normalized jid for a WhatsApp user', async () => {
  const out = await handle({ sender: '40712345678@s.whatsapp.net', level: 'group' });
  assert.match(out, /You are \+40712345678 in a group chat/); // friendly form, for reading
  assert.match(out, /40712345678@s\.whatsapp\.net/); // the normalized jid, to copy into OWNER_JID / whitelist
});

test('whoami: shows the bare id plus the lid for a LID, and the raw value when already friendly', async () => {
  const lid = await handle({ sender: '5678@lid' });
  assert.match(lid, /You are 5678 in a private chat/); // friendly bare id
  assert.match(lid, /5678@lid/); // the normalized lid jid, exposed for the owner to copy
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

test('whoami: "forget" drops a person identity mapping via the platform capability', async () => {
  const forgotten = [];
  const opts = { forgetIdentity: (token) => { forgotten.push(token); return forgotten.length === 1; } };
  const ok = await handle({ text: 'jarvis whoami forget 40712345678' }, opts);
  assert.match(ok, /Forgot the stored identity mapping/);
  assert.match(ok, /re-learned from their next message/);
  assert.deepEqual(forgotten, ['40712345678']);
  const none = await handle({ text: 'jarvis whoami forget 40712345678' }, opts); // second call: capability returns false
  assert.match(none, /Nothing stored/);
});

test('whoami: "forget" prefers the @mention, needs a target, and reports when unavailable', async () => {
  const forgotten = [];
  const opts = { forgetIdentity: (token) => { forgotten.push(token); return true; } };
  await handle({ text: 'jarvis whoami forget @john', mentionedJid: ['111@lid'] }, opts);
  assert.deepEqual(forgotten, ['111@lid']); // the mention wins over the typed token
  assert.match(await handle({ text: 'jarvis whoami forget' }, opts), /Usage/);
  // off WhatsApp (no capability injected) it reports unavailable instead of throwing
  assert.match(await handle({ text: 'jarvis whoami forget 40712' }), /unavailable here/i);
});
