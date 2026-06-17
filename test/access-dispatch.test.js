import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createAccessPolicy } from '../src/core/access.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import ping from '../src/commands/ping.js';
import help from '../src/commands/help.js';
import owner from '../src/commands/owner.js';
import shutdown from '../src/commands/shutdown.js';
import note from '../src/commands/note.js';

/** A dispatcher sharing one store with a policy we can pre-populate (same KV ns). */
function setup({ owner: ownerId = '', commands = [ping, help, owner, shutdown] } = {}) {
  const store = createStore({ path: ':memory:' });
  const access = createAccessPolicy(store);
  const lifecycle = { shutdown() {}, restart() {}, logout() {} };
  const handle = createDispatcher(createRegistry(commands), { store, owner: ownerId, lifecycle });
  return { handle, access };
}

test('dispatch+access: a blacklisted sender is silently ignored; others pass', async () => {
  const { handle, access } = setup();
  access.add('blacklist', 'ping', 'c1', 'bob');
  access.enable('blacklist', 'ping', 'c1');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'alice', chatId: 'c1', level: 'group' }), 'pong');
});

test('dispatch+access: a whitelist restricts the command to listed people', async () => {
  const { handle, access } = setup();
  access.add('whitelist', 'ping', 'c1', 'alice');
  access.enable('whitelist', 'ping', 'c1');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'alice', chatId: 'c1', level: 'group' }), 'pong');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined);
});

test('dispatch+access: the global gate silences a blocked sender even for a bare prefix or junk', async () => {
  const { handle, access } = setup();
  access.enable('whitelist', '*', '*'); // private bot (only the owner, who bypasses)
  assert.equal(await handle({ text: 'jarvis', sender: 'x', chatId: 'c1' }), undefined); // no "Try help"
  assert.equal(await handle({ text: 'jarvis frobnicate', sender: 'x', chatId: 'c1' }), undefined); // no "Unknown command"
  assert.equal(await handle({ text: 'jarvis ping', sender: 'x', chatId: 'c1' }), undefined);
});

test('dispatch+access: the owner bypasses every list', async () => {
  const { handle, access } = setup({ owner: 'boss' });
  access.add('blacklist', 'ping', '*', '*'); // ping blocked for everyone, everywhere
  access.enable('blacklist', 'ping', '*');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'boss', chatId: 'c1' }), 'pong'); // owner still passes
  assert.equal(await handle({ text: 'jarvis ping', sender: 'x', chatId: 'c1' }), undefined); // everyone else silent
});

test('dispatch+access: the owner command stays reachable despite a private-bot gate (anti-lockout)', async () => {
  const { handle, access } = setup({ commands: [owner, ping] }); // no env owner; nobody owns it yet
  access.enable('whitelist', '*', '*'); // bot private
  assert.match(
    await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'private', chatId: 'c1' }),
    /you are now the owner/i,
  );
});

test('dispatch+access: owner-only commands are governed by scope, not lists', async () => {
  const { handle } = setup({ owner: 'boss' });
  // a non-owner, not globally blocked, gets the scope message (not silence)
  assert.match(await handle({ text: 'jarvis shutdown', sender: 'x', chatId: 'c1' }), /Not allowed: owner only/);
});

test('dispatch+access: with no store the access layer is inactive (everything public)', async () => {
  const handle = createDispatcher(createRegistry([ping]));
  assert.equal(await handle({ text: 'jarvis ping', sender: 'anyone', chatId: 'c1' }), 'pong');
});

test('dispatch+access: the global gate and a per-command list both apply (two tiers)', async () => {
  const { handle, access } = setup({ commands: [ping, note, owner] });
  access.add('whitelist', '*', '*', 'alice'); // bot answers only alice...
  access.enable('whitelist', '*', '*');
  access.add('blacklist', 'note', '*', 'alice'); // ...but alice is barred from note
  access.enable('blacklist', 'note', '*');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'alice', chatId: 'c1', level: 'group' }), 'pong');
  assert.equal(await handle({ text: 'jarvis note list', sender: 'alice', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined); // fails the global gate
});
