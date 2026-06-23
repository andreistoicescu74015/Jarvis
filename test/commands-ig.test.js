import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import ig from '../src/commands/ig.js';
import { toPlain } from '../src/core/format.js';

/** A fake `ctx.instagram` capability that records the command's calls. */
function fakeIg(overrides = {}) {
  const calls = { send: [], threads: 0, code: [] };
  return {
    calls,
    send: async (person, text) => { calls.send.push({ person, text }); return overrides.send ?? true; },
    threads: async () => { calls.threads += 1; return overrides.threads ?? [{ username: 'alice', name: 'Alice', unread: true, lastText: 'hi' }]; },
    code: async (v) => { calls.code.push(v); return overrides.code ?? true; },
  };
}

const handleFor = (instagram) => createDispatcher(createRegistry([ig]), { owner: 'boss', instagram });

test('ig: lists recent threads', async () => {
  const instagram = fakeIg();
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig', sender: 'boss', level: 'private' }));
  assert.match(out, /Instagram - recent threads/);
  assert.match(out, /Alice \(unread\): hi/);
  assert.equal(instagram.calls.threads, 1);
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

test('ig: reports when the bridge could not send', async () => {
  const instagram = fakeIg({ send: false });
  const out = toPlain(await handleFor(instagram)({ text: 'jarvis ig alice yo', sender: 'boss', level: 'private' }));
  assert.match(out, /Could not send to alice/);
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
  assert.equal(instagram.calls.threads, 0); // never reached the handler
});

test('ig: reports unavailable where no Instagram bridge is configured (e.g. CLI)', async () => {
  const handle = createDispatcher(createRegistry([ig]), { owner: 'boss' }); // no instagram capability
  const out = await handle({ text: 'jarvis ig', sender: 'boss', level: 'private' });
  assert.match(toPlain(out), /unavailable here/);
});
