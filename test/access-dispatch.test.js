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
  access.enable('whitelist', '*', 'private'); // lock the bot in DMs (only the owner, who bypasses)
  assert.equal(await handle({ text: 'jarvis', sender: 'x', chatId: 'c1' }), undefined); // no "Try help"
  assert.equal(await handle({ text: 'jarvis frobnicate', sender: 'x', chatId: 'c1' }), undefined); // no "Unknown command"
  assert.equal(await handle({ text: 'jarvis ping', sender: 'x', chatId: 'c1' }), undefined);
});

test('dispatch+access: the owner bypasses every list', async () => {
  const { handle, access } = setup({ owner: 'boss' });
  access.add('blacklist', 'ping', 'private', '*'); // ping blocked for everyone in DMs
  access.enable('blacklist', 'ping', 'private');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'boss', chatId: 'c1' }), 'pong'); // owner still passes
  assert.equal(await handle({ text: 'jarvis ping', sender: 'x', chatId: 'c1' }), undefined); // everyone else silent
});

test('dispatch+access: the owner command stays reachable despite a private-bot gate (anti-lockout)', async () => {
  const { handle, access } = setup({ commands: [owner, ping] }); // no env owner; nobody owns it yet
  access.enable('whitelist', '*', 'private'); // bot locked in DMs
  assert.match(
    await handle({ text: 'jarvis owner claim', sender: 'alice', level: 'private', chatId: 'c1' }),
    /you are now the owner/i,
  );
});

test('dispatch+access: owner-only commands are governed by scope, not lists', async () => {
  const { handle } = setup({ owner: 'boss' });
  // a non-owner, not globally blocked (a group context, where there is no private lockdown), gets the
  // scope message (not silence)
  assert.match(await handle({ text: 'jarvis shutdown', sender: 'x', chatId: 'c1', level: 'group' }), /Not allowed: owner only/);
});

test('dispatch+access: an established owner locks the bot DMs to them (anti-lockout on owner)', async () => {
  const { handle } = setup({ owner: 'boss' });
  // once an owner exists, a stranger cannot DM the bot...
  assert.equal(await handle({ text: 'jarvis ping', sender: 'rando', level: 'private', chatId: 'dm' }), undefined);
  // ...the owner can, and the bootstrap `owner` command stays reachable to anyone (anti-lockout)
  assert.equal(await handle({ text: 'jarvis ping', sender: 'boss', level: 'private', chatId: 'dm' }), 'pong');
  assert.match(await handle({ text: 'jarvis owner', sender: 'rando', level: 'private', chatId: 'dm' }), /Owner/);
});

test('dispatch+access: claiming locks the DMs; resigning clears the lock (symmetric)', async () => {
  const { handle, access } = setup(); // no env owner; nobody owns it yet
  await handle({ text: 'jarvis owner claim', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.equal(access.get('*', 'private').active, 'whitelist'); // claim locked the DMs
  await handle({ text: 'jarvis owner resign', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.equal(access.get('*', 'private').active, 'public'); // resign cleared it for the next owner
});

test('dispatch+access: with no store the access layer is inactive (everything public)', async () => {
  const handle = createDispatcher(createRegistry([ping]));
  assert.equal(await handle({ text: 'jarvis ping', sender: 'anyone', chatId: 'c1' }), 'pong');
});

test('dispatch+access: the global gate and a per-command list both apply (two tiers)', async () => {
  const { handle, access } = setup({ commands: [ping, note, owner] });
  access.add('whitelist', '*', 'c1', 'alice'); // in c1 the bot answers only alice...
  access.enable('whitelist', '*', 'c1');
  access.add('blacklist', 'note', 'c1', 'alice'); // ...but alice is barred from note there
  access.enable('blacklist', 'note', 'c1');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'alice', chatId: 'c1', level: 'group' }), 'pong');
  assert.equal(await handle({ text: 'jarvis note list', sender: 'alice', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined); // fails the global gate
});

test('dispatch+access: a denial is logged for audit (never chatted)', async () => {
  const store = createStore({ path: ':memory:' });
  const access = createAccessPolicy(store);
  access.add('blacklist', 'ping', 'c1', 'bob');
  access.enable('blacklist', 'ping', 'c1');
  const logs = [];
  const log = { debug() {}, info: (m, f) => logs.push({ m, f }), warn() {}, error() {} };
  const handle = createDispatcher(createRegistry([ping]), { store, log });
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined);
  assert.ok(logs.some((l) => /access deny/.test(l.m)), 'expected the denial to be logged');
});

test('dispatch+access: every DM shares one "private" context (not one per contact)', async () => {
  const { handle, access } = setup();
  access.enable('whitelist', '*', 'private'); // lock Jarvis's DMs to listed people
  access.add('whitelist', '*', 'private', 'alice');
  // two different DMs (different chatIds) are governed by the single private policy
  assert.equal(await handle({ text: 'jarvis ping', sender: 'alice', chatId: 'dmA', level: 'private' }), 'pong');
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'dmB', level: 'private' }), undefined);
  // a group is its own context, unaffected by the private policy
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'gX', level: 'group' }), 'pong');
});
