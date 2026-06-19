import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import ping from '../src/commands/ping.js';
import owner from '../src/commands/owner.js';

// The activation gate (`requireOwner`): until an owner exists, Jarvis is dormant - silent in groups,
// and in a private chat only the `owner` command (the claim path) responds. Off by default.
const reg = () => createRegistry([ping, owner]);

test('activation: no owner -> fully silent in groups (even the owner command)', async () => {
  const handle = createDispatcher(reg(), { requireOwner: true });
  assert.equal(await handle({ text: 'jarvis ping', sender: 'u', chatId: 'g1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis owner', sender: 'u', chatId: 'g1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis owner claim', sender: 'u', chatId: 'g1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis', sender: 'u', chatId: 'g1', level: 'group' }), undefined); // bare prefix too
});

test('activation: no owner -> in private only `owner` responds', async () => {
  const handle = createDispatcher(reg(), { requireOwner: true });
  assert.equal(await handle({ text: 'jarvis ping', sender: 'u', level: 'private' }), undefined); // dormant
  assert.match(toPlain(await handle({ text: 'jarvis owner', sender: 'u', level: 'private' })), /No owner yet/);
});

test('activation: claiming in private activates the bot everywhere', async () => {
  const handle = createDispatcher(reg(), { requireOwner: true });
  assert.match(toPlain(await handle({ text: 'jarvis owner claim', sender: 'boss', level: 'private' })), /now the owner/i);
  // owned now -> commands respond, including in groups, for anyone (no access lists set)
  assert.equal(await handle({ text: 'jarvis ping', sender: 'anyone', chatId: 'g1', level: 'group' }), 'pong');
});

test('activation: an env owner activates from the very first message', async () => {
  const handle = createDispatcher(reg(), { requireOwner: true, owner: 'boss' });
  assert.equal(await handle({ text: 'jarvis ping', sender: 'anyone', chatId: 'g1', level: 'group' }), 'pong');
});

test('activation: default (requireOwner off) responds with no owner, as before', async () => {
  const handle = createDispatcher(reg()); // gate disabled
  assert.equal(await handle({ text: 'jarvis ping', sender: 'u', chatId: 'g1', level: 'group' }), 'pong');
});
