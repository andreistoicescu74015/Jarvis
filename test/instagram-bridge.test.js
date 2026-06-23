import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createBridge } from '../src/instagram/bridge.js';
import { toPlain } from '../src/core/format.js';

/** A sidecar-client double that records what the bridge asked it to do. */
function fakeClient() {
  const calls = { send: [], threads: 0, challenge: [] };
  return {
    calls,
    send: async (m) => { calls.send.push(m); return true; },
    threads: async () => { calls.threads += 1; return [{ username: 'alice', name: 'Alice', unread: false, lastText: 'hi' }]; },
    challenge: async (v) => { calls.challenge.push(v); return true; },
  };
}

function setup({ owner = 'boss@s.whatsapp.net' } = {}) {
  const store = createStore({ path: ':memory:' });
  const sent = [];
  const client = fakeClient();
  const bridge = createBridge({
    store,
    send: (target, text) => sent.push({ target, text: toPlain(text) }),
    owner,
    client,
    prefix: 'jarvis',
  });
  return { store, sent, client, bridge };
}

test('bridge: an inbound DM is relayed to the owner, tagged with the sender and a reply hint', async () => {
  const { sent, bridge } = setup();
  const ok = await bridge.ingest({ type: 'message', username: 'Alice', name: 'Alice P', threadId: 't1', userId: 'u1', text: 'hey there' });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'boss@s.whatsapp.net');
  assert.match(sent[0].text, /\[IG\] Alice P: hey there/);
  assert.match(sent[0].text, /reply: jarvis ig alice <message>/); // username lowercased into the hint
});

test('bridge: an inbound DM is remembered, so a reply by username resolves to its thread', async () => {
  const { bridge, client } = setup();
  await bridge.ingest({ type: 'message', username: 'Alice', name: 'Alice P', threadId: 't1', userId: 'u1', text: 'hi' });
  await bridge.capability.send('@Alice', 'hello back'); // different case + a leading @
  assert.deepEqual(client.calls.send[0], { username: 'alice', threadId: 't1', userId: 'u1', text: 'hello back' });
});

test('bridge: a reply to an unknown person still sends (the sidecar resolves the username)', async () => {
  const { bridge, client } = setup();
  await bridge.capability.send('charlie', 'yo');
  assert.deepEqual(client.calls.send[0], { username: 'charlie', threadId: undefined, userId: undefined, text: 'yo' });
});

test('bridge: a challenge event asks the owner for a code', async () => {
  const { sent, bridge } = setup();
  const ok = await bridge.ingest({ type: 'challenge', detail: 'Code sent to e***@mail.com' });
  assert.equal(ok, true);
  assert.match(sent[0].text, /Instagram needs you to confirm a login/);
  assert.match(sent[0].text, /jarvis ig code <value>/);
});

test('bridge: with no owner configured, an inbound event is dropped (no relay target)', async () => {
  const { sent, bridge } = setup({ owner: '' });
  const ok = await bridge.ingest({ type: 'message', username: 'alice', text: 'hi' });
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});

test('bridge: an unknown event type is ignored', async () => {
  const { sent, bridge } = setup();
  assert.equal(await bridge.ingest({ type: 'reaction' }), false);
  assert.equal(sent.length, 0);
});

test('bridge: capability threads/code forward to the client', async () => {
  const { bridge, client } = setup();
  const threads = await bridge.capability.threads();
  assert.equal(threads[0].username, 'alice');
  assert.equal(client.calls.threads, 1);
  assert.equal(await bridge.capability.code('123'), true);
  assert.deepEqual(client.calls.challenge, ['123']);
});
