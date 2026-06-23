import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import ig from '../src/commands/ig.js';
import { toPlain } from '../src/core/format.js';

/** A fake `ctx.instagram` capability that records the command's calls. */
function fakeIg(overrides = {}) {
  const calls = { send: [], sendThread: [], code: [], status: 0, threads: 0, messages: [] };
  return {
    calls,
    send: async (person, text) => { calls.send.push({ person, text }); return overrides.send ?? { ok: true }; },
    sendThread: async (threadId, text) => { calls.sendThread.push({ threadId, text }); return overrides.sendThread ?? { ok: true }; },
    threads: async () => { calls.threads += 1; return overrides.threads ?? { ok: true, threads: [] }; },
    messages: async (opts) => { calls.messages.push(opts); return overrides.messages ?? { ok: true, title: 'maria', messages: [{ fromMe: false, username: 'maria', text: 'hey' }, { fromMe: true, username: '', text: 'salut' }] }; },
    code: async (v) => { calls.code.push(v); return overrides.code ?? true; },
    status: async () => { calls.status += 1; return overrides.status ?? { ok: true, state: 'logged_in', account: 'me', sentLastHour: 2 }; },
  };
}

const handleFor = (instagram, store) => createDispatcher(createRegistry([ig]), { owner: 'boss', instagram, store });

test('ig: shows bridge status', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig', sender: 'boss', level: 'private' }));
  assert.match(out, /Instagram bridge/);
  assert.match(out, /State: logged_in \(me\)/);
  assert.match(out, /2 sent in the last hour/);
  assert.equal(instagram.calls.status, 1);
});

test('ig: send <user> <message> sends a 1:1 DM and confirms', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send alice hey there', sender: 'boss', level: 'private' }));
  assert.match(out, /Sent to alice on Instagram/);
  assert.deepEqual(instagram.calls.send[0], { person: 'alice', text: 'hey there' });
});

test('ig: send with no message is a mis-usage', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send alice', sender: 'boss', level: 'private' }));
  assert.match(out, /Usage: jarvis ig send/);
  assert.equal(instagram.calls.send.length, 0);
});

test('ig: an unknown action is a mis-usage', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig frobnicate alice', sender: 'boss', level: 'private' }));
  assert.match(out, /Usage: jarvis ig list/);
  assert.equal(instagram.calls.send.length, 0);
});

test('ig: a pending challenge tells the owner to submit a code', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'challenge_required', detail: 'code sent' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send alice yo', sender: 'boss', level: 'private' }));
  assert.match(out, /needs a login code/i);
  assert.match(out, /jarvis ig code <value>/);
});

test('ig: a rate-cap is reported clearly', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'rate_capped' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send alice yo', sender: 'boss', level: 'private' }));
  assert.match(out, /hourly send cap/i);
});

test('ig: an over-long message is reported', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'too_long' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send alice loooong', sender: 'boss', level: 'private' }));
  assert.match(out, /too long for an Instagram DM/);
});

test('ig: an unknown user is reported', async () => {
  const instagram = fakeIg({ send: { ok: false, reason: 'unknown_user' } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig send nobody hi', sender: 'boss', level: 'private' }));
  assert.match(out, /Couldn't find Instagram user nobody/);
});

test('ig: submits a challenge code', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig code 123456', sender: 'boss', level: 'private' }));
  assert.match(out, /Submitted the code/);
  assert.deepEqual(instagram.calls.code, ['123456']);
});

test('ig: list shows recent conversations (groups tagged) and remembers them by number', async () => {
  const store = createStore({ path: ':memory:' });
  const instagram = fakeIg({ threads: { ok: true, threads: [
    { threadId: 't1', title: 'maria', isGroup: false, count: 2 },
    { threadId: 't2', title: 'Gasca mea', isGroup: true, count: 5 },
  ] } });
  const handle = handleFor(instagram, store);
  const listed = toPlain(await handle({ text: 'jarvis ig list', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(listed, /1\. maria/);
  assert.match(listed, /2\. Gasca mea \(group\)/);
  // send to conversation #2 (the group), resolved from the remembered list
  const sent = toPlain(await handle({ text: 'jarvis ig send 2 salut grup', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(sent, /Sent to Gasca mea on Instagram/);
  assert.deepEqual(instagram.calls.sendThread[0], { threadId: 't2', text: 'salut grup' });
  store.close();
});

test('ig: send to an unknown number reports no such conversation', async () => {
  const store = createStore({ path: ':memory:' });
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram, store)({ text: 'jarvis ig send 9 hi', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /No conversation #9/);
  assert.equal(instagram.calls.sendThread.length, 0);
  store.close();
});

test('ig: read <user> [count] shows the last messages of a 1:1', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig read maria 5', sender: 'boss', level: 'private' }));
  assert.match(out, /IG - maria/);
  assert.match(out, /maria: hey/);
  assert.match(out, /me: salut/);
  assert.deepEqual(instagram.calls.messages[0], { username: 'maria', amount: 5 });
});

test('ig: read by number uses the thread from the last list', async () => {
  const store = createStore({ path: ':memory:' });
  const instagram = fakeIg({ threads: { ok: true, threads: [
    { threadId: 't1', title: 'maria', isGroup: false, count: 2 },
    { threadId: 't2', title: 'Gasca', isGroup: true, count: 4 },
  ] } });
  const handle = handleFor(instagram, store);
  await handle({ text: 'jarvis ig list', sender: 'boss', level: 'private', chatId: 'dm' });
  await handle({ text: 'jarvis ig read 2', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.deepEqual(instagram.calls.messages[0], { threadId: 't2', amount: 10 });
  store.close();
});

test('ig: read with no target is a mis-usage', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig read', sender: 'boss', level: 'private' }));
  assert.match(out, /Usage: jarvis ig read/);
  assert.equal(instagram.calls.messages.length, 0);
});

test('ig: read of an unknown conversation is reported', async () => {
  const instagram = fakeIg({ messages: { ok: false, reason: 'unknown_user', messages: [] } });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig read nobody', sender: 'boss', level: 'private' }));
  assert.match(out, /Couldn't find a conversation with nobody/);
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
