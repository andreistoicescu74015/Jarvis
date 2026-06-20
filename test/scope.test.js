import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope, sameUser } from '../src/core/scope.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createApp } from '../src/core/app.js';
import { createTestAdapter } from './helpers.js';

// --- unit: sameUser ---
test('sameUser: matches ignoring device suffix and case; empty is never equal', () => {
  assert.ok(sameUser('User:3', 'user'));
  assert.ok(sameUser('a@x', 'a@x'));
  assert.ok(sameUser('40712:3@s.whatsapp.net', '40712@s.whatsapp.net')); // device stripped, domain kept
  assert.ok(!sameUser('40712@lid', '40712@s.whatsapp.net')); // different id spaces never collide
  assert.ok(!sameUser('a', 'b'));
  assert.ok(!sameUser('', 'a'));
});

// --- unit: checkScope ---
test('checkScope: no scope is always ok', () => {
  assert.deepEqual(checkScope(undefined, { level: 'private', isAdmin: false, isOwner: false }), { ok: true });
});

test('checkScope: owner requirement', () => {
  assert.equal(checkScope({ owner: true }, { level: 'private', isAdmin: false, isOwner: false }).ok, false);
  assert.equal(checkScope({ owner: true }, { level: 'private', isAdmin: false, isOwner: true }).ok, true);
});

test('checkScope: admin enforced in groups and communities (private user is the authority)', () => {
  assert.equal(checkScope({ admin: true }, { level: 'group', isAdmin: false, isOwner: false }).ok, false);
  assert.equal(checkScope({ admin: true }, { level: 'group', isAdmin: true, isOwner: false }).ok, true);
  // a community is a multi-user space too: a non-admin must not pass an admin-gated command there.
  assert.equal(checkScope({ admin: true }, { level: 'community', isAdmin: false, isOwner: false }).ok, false);
  assert.equal(checkScope({ admin: true }, { level: 'community', isAdmin: true, isOwner: false }).ok, true);
  assert.equal(checkScope({ admin: true }, { level: 'private', isAdmin: false, isOwner: false }).ok, true);
});

test('checkScope: level must match', () => {
  assert.equal(checkScope({ level: 'group' }, { level: 'private', isAdmin: false, isOwner: false }).ok, false);
  assert.equal(checkScope({ level: 'group' }, { level: 'group', isAdmin: false, isOwner: false }).ok, true);
});

// --- integration: dispatcher enforces scope + builds ctx identity ---
async function run(text, { commands, owner = '', match, msg = {} }) {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: createDispatcher(createRegistry(commands), { owner, match }) });
  await app.start();
  await adapter.receive({ text, ...msg });
  return adapter.sent;
}

const ownerCmd = { name: 'secret', summary: 's', scope: { owner: true }, run: () => 'top secret' };

test('dispatch: owner-only command is denied for a non-owner', async () => {
  const sent = await run('jarvis secret', { commands: [ownerCmd], owner: 'boss', msg: { sender: 'rando' } });
  assert.match(sent[0].text, /Not allowed: owner only/);
});

test('dispatch: owner-only command runs for the owner', async () => {
  const sent = await run('jarvis secret', { commands: [ownerCmd], owner: 'boss', msg: { sender: 'boss' } });
  assert.deepEqual(sent.map((s) => s.text), ['top secret']);
});

test('dispatch: ctx carries identity (level/sender/isOwner/isAdmin)', async () => {
  let seen;
  const probe = {
    name: 'probe',
    summary: 'p',
    run: (ctx) => {
      seen = { level: ctx.level, sender: ctx.sender, isOwner: ctx.isOwner, isAdmin: ctx.isAdmin };
      return 'ok';
    },
  };
  await run('jarvis probe', { commands: [probe], owner: 'me', msg: { level: 'group', sender: 'me', isAdmin: true } });
  assert.deepEqual(seen, { level: 'group', sender: 'me', isOwner: true, isAdmin: true });
});

test('dispatch: owner match is injectable (LID-aware bridging)', async () => {
  const bridge = (a, b) => a === b || (a === 'lid' && b === 'pn');
  const sent = await run('jarvis secret', {
    commands: [ownerCmd],
    owner: 'pn',
    match: bridge,
    msg: { sender: 'lid' },
  });
  assert.deepEqual(sent.map((s) => s.text), ['top secret']);
});
