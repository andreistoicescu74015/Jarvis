import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import owner from '../src/commands/owner.js';
import shutdown from '../src/commands/shutdown.js';
import { toPlain } from '../src/core/format.js';

// --- unit: the command logic, with a stubbed ctx.owner ---
function stub(state) {
  const calls = { claim: 0, resign: 0 };
  const ctx = {
    args: state.args ?? [],
    owner: {
      exists: state.exists ?? false,
      isMe: state.isMe ?? false,
      fromEnv: state.fromEnv ?? false,
      contact: state.contact ?? '',
      claim: () => { calls.claim += 1; return true; },
      resign: () => { calls.resign += 1; },
    },
  };
  return { ctx, calls };
}

test('owner cmd: show - reports the owner (contact only to the owner) or that there is none', () => {
  assert.match(owner.run(stub({}).ctx), /no owner yet/i);
  assert.match(toPlain(owner.run(stub({ exists: true, isMe: true, contact: 'x@s.whatsapp.net' }).ctx)), /Owner: x@s\.whatsapp\.net/);
  // a non-owner learns there IS an owner, never who: the contact is a personal id
  const other = toPlain(owner.run(stub({ exists: true, contact: 'x@s.whatsapp.net' }).ctx));
  assert.match(other, /already has an owner/i);
  assert.doesNotMatch(other, /x@s\.whatsapp\.net/);
});

test('owner cmd: claim - takes a free slot, otherwise shows the owner', () => {
  const free = stub({ args: ['claim'] });
  assert.match(owner.run(free.ctx), /you are now the owner/i);
  assert.equal(free.calls.claim, 1);

  const taken = stub({ args: ['claim'], exists: true, contact: 'boss' });
  const takenOut = toPlain(owner.run(taken.ctx));
  assert.match(takenOut, /already an owner/i);
  assert.doesNotMatch(takenOut, /boss/); // the contact is not revealed to a would-be claimer
  assert.equal(taken.calls.claim, 0);

  const mine = stub({ args: ['claim'], exists: true, isMe: true });
  assert.match(owner.run(mine.ctx), /already the owner/i);
  assert.equal(mine.calls.claim, 0);
});

test('owner cmd: resign - only the owner, and not an env-configured one', () => {
  const me = stub({ args: ['resign'], exists: true, isMe: true });
  assert.match(owner.run(me.ctx), /resigned/i);
  assert.equal(me.calls.resign, 1);

  const notMe = stub({ args: ['resign'], exists: true, isMe: false });
  assert.match(owner.run(notMe.ctx), /only the current owner/i);
  assert.equal(notMe.calls.resign, 0);

  const env = stub({ args: ['resign'], exists: true, isMe: true, fromEnv: true });
  assert.match(owner.run(env.ctx), /configured via OWNER_JID/i);
  assert.equal(env.calls.resign, 0);
});

test('owner cmd: unavailable without the capability', () => {
  assert.match(owner.run({ args: ['claim'] }), /unavailable/i);
});

// --- integration: through the dispatcher (real owner resolver + ctx.owner) ---
const lifecycle = { shutdown() {}, restart() {}, logout() {} };

test('owner cmd: claim is private-only, then gates the owner-only commands', async () => {
  const handle = createDispatcher(createRegistry([owner, shutdown]), { owner: '', lifecycle });
  // a claim from a group is refused - ownership must be taken in a private chat
  assert.match(await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'group' }), /private chat/i);
  assert.match(await handle({ text: 'jarvis owner', sender: 'bob', level: 'group' }), /no owner yet/i); // still unclaimed
  // in a private chat it works, then gates the owner-only commands everywhere
  assert.match(await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'private' }), /you are now the owner/i);
  assert.match(await handle({ text: 'jarvis shutdown', sender: 'bob', level: 'private' }), /Not allowed: owner only/);
  assert.match(await handle({ text: 'jarvis shutdown', sender: 'alice', level: 'private' }), /shutting down/i);
});

test('owner cmd: an env owner is not overridable and cannot resign', async () => {
  const handle = createDispatcher(createRegistry([owner]), { owner: 'boss' });
  const out = toPlain(await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'private' }));
  assert.match(out, /already an owner/i);
  assert.doesNotMatch(out, /boss/); // and the claim attempt does not leak whose slot it is
  assert.match(await handle({ text: 'jarvis owner resign', sender: 'boss', level: 'private' }), /configured via OWNER_JID/i);
});

test('owner cmd: a temporary owner can resign, freeing the slot for the next claimer', async () => {
  const handle = createDispatcher(createRegistry([owner]), { owner: '' });
  await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'private' });
  assert.match(await handle({ text: 'jarvis owner resign', sender: 'alice', level: 'private' }), /resigned/i);
  assert.match(await handle({ text: 'jarvis owner claim', sender: 'bob', level: 'private' }), /you are now the owner/i);
});

test('owner cmd: owner-only commands no longer implicitly claim ownership', async () => {
  const handle = createDispatcher(createRegistry([owner, shutdown]), { owner: '', lifecycle });
  assert.match(await handle({ text: 'jarvis shutdown', sender: 'x', level: 'private' }), /Not allowed: owner only/);
  assert.match(await handle({ text: 'jarvis owner', sender: 'y', level: 'private' }), /no owner yet/i); // x did not claim
});
