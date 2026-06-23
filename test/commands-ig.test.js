import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import ig from '../src/commands/ig.js';
import { toPlain } from '../src/core/format.js';

/** A fake `ctx.instagram` capability that records the command's calls. */
function fakeIg(overrides = {}) {
  const calls = { send: [], code: [], status: 0 };
  return {
    calls,
    send: async (person, text) => { calls.send.push({ person, text }); return overrides.send ?? { ok: true }; },
    code: async (v) => { calls.code.push(v); return overrides.code ?? true; },
    status: async () => { calls.status += 1; return overrides.status ?? { ok: true, state: 'logged_in', account: 'me', sentLastHour: 2 }; },
  };
}

const handleFor = (instagram) => createDispatcher(createRegistry([ig]), { owner: 'boss', instagram });

test('ig: shows bridge status', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig', sender: 'boss', level: 'private' }));
  assert.match(out, /Instagram bridge/);
  assert.match(out, /State: logged_in \(me\)/);
  assert.match(out, /2 sent in the last hour/);
  assert.equal(instagram.calls.status, 1);
});

test('ig: sends a DM and confirms', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig alice hey there', sender: 'boss', level: 'private' }));
  assert.match(out, /Sent to alice on Instagram/);
  assert.deepEqual(instagram.calls.send[0], { person: 'alice', text: 'hey there' });
});

test('ig: a send with no message is a mis-usage (usage text)', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig alice', sender: 'boss', level: 'private' }));
  assert.match(out, /Usage: jarvis ig <person> <message>/);
  assert.equal(instagram.calls.send.length, 0);
});

test('ig: a pending challenge tells the owner to submit a code', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'challenge_required', detail: 'code sent' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig alice yo', sender: 'boss', level: 'private' }));
  assert.match(out, /needs a login code/i);
  assert.match(out, /jarvis ig code <value>/);
});

test('ig: a rate-cap is reported clearly', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'rate_capped' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig alice yo', sender: 'boss', level: 'private' }));
  assert.match(out, /hourly send cap/i);
});

test('ig: an unknown user is reported', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'unknown_user' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig nobody hi', sender: 'boss', level: 'private' }));
  assert.match(out, /Couldn't find Instagram user nobody/);
});

test('ig: submits a challenge code', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig code 123456', sender: 'boss', level: 'private' }));
  assert.match(out, /Submitted the code/);
  assert.deepEqual(instagram.calls.code, ['123456']);
});

test('ig: is owner-only', async () => {
  const instagram = fakeIg();
  const denied = await handleFor(instagram)({ text: 'jarvis ig', sender: 'rando', level: 'private' });
  assert.match(toPlain(denied), /Not allowed: owner only/);
  assert.equal(instagram.calls.status, 0); // never reached the handler
});

test('ig: reports unavailable where no bridge is configured (e.g. CLI)', async () => {
  const handle = createDispatcher(createRegistry([ig]), { owner: 'boss' }); // no instagram capability
  assert.match(toPlain(await handle({ text: 'jarvis ig', sender: 'boss', level: 'private' })), /unavailable here/);
});
