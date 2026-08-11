import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import { createStore } from '../src/store/index.js';
import { commands } from '../src/commands/index.js';
import ping from '../src/commands/ping.js';
import help from '../src/commands/help.js';
import shutdown from '../src/commands/shutdown.js';
import schedule from '../src/commands/schedule.js';
import owner from '../src/commands/owner.js';

const dispatch = createDispatcher(createRegistry([ping, help, shutdown, schedule]), { owner: 'boss' });
const handle = async (msg) => toPlain(await dispatch(msg));

test('help: greets and explains how to address the bot', async () => {
  const out = await handle({ text: 'jarvis help', sender: 'rando', level: 'group' });
  assert.match(out, /Address me with jarvis <command> or by @mentioning me/);
  assert.match(out, /ping: /); // a public command is listed
});

test('help: hides commands the caller cannot run here', async () => {
  const asUser = await handle({ text: 'jarvis help', sender: 'rando', level: 'group', isAdmin: false });
  assert.doesNotMatch(asUser, /shutdown: /); // owner-only, hidden from a non-owner
  const asOwner = await handle({ text: 'jarvis help', sender: 'boss', level: 'group' });
  assert.match(asOwner, /shutdown: /); // the owner sees it
});

test('help: a proactive command is hidden in a private chat for a non-owner', async () => {
  const inPrivate = await handle({ text: 'jarvis help', sender: 'rando', level: 'private' });
  assert.doesNotMatch(inPrivate, /schedule: /); // proactive is group-only for non-owners
  const inGroupAsAdmin = await handle({ text: 'jarvis help', sender: 'rando', level: 'group', isAdmin: true });
  assert.match(inGroupAsAdmin, /schedule: /); // an admin in a group may schedule
});

test('help owner: lists only the owner-only commands (for the owner)', async () => {
  const out = await handle({ text: 'jarvis help owner', sender: 'boss', level: 'group' });
  assert.match(out, /Owner-only commands/);
  assert.match(out, /shutdown: /); // owner-scoped
  assert.doesNotMatch(out, /ping: /); // public command excluded from the owner filter
  assert.doesNotMatch(out, /schedule: /); // admin-level, not owner-only
});

test('help admin: lists only the admin-level commands', async () => {
  const out = await handle({ text: 'jarvis help admin', sender: 'boss', level: 'group' });
  assert.match(out, /Admin commands/);
  assert.match(out, /schedule: /); // admin/proactive
  assert.doesNotMatch(out, /shutdown: /); // owner-only, not admin-level
  assert.doesNotMatch(out, /ping: /);
});

test('help owner: a non-owner has none (privilege-aware, not advertised)', async () => {
  const out = await handle({ text: 'jarvis help owner', sender: 'rando', level: 'group', isAdmin: false });
  assert.match(out, /No owner commands available to you here/i);
});

test('help: the owner command is hidden once ownership is settled, listed while unclaimed', async () => {
  // An env owner is set -> owner claim is taken and an env owner can't resign -> not actionable -> hidden.
  const settled = createDispatcher(createRegistry([ping, help, owner]), { owner: 'boss' });
  const out1 = toPlain(await settled({ text: 'jarvis help', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.doesNotMatch(out1, /owner: /); // hidden from the list...
  assert.match(out1, /ping: /); // ...while the rest still shows

  // No owner configured -> the command is the bootstrap, so it stays listed (claimable).
  const fresh = createDispatcher(createRegistry([ping, help, owner]), {});
  const out2 = toPlain(await fresh({ text: 'jarvis help', sender: 'rando', level: 'private', chatId: 'dm' }));
  assert.match(out2, /owner: /);
});

test('help: the full list is grouped by who each command is for, not alphabetical', async () => {
  // A first-time reader met `ai`, `alias`, `blacklist` before `note`, with owner lifecycle switches
  // mixed among everyday commands and nothing saying which was which.
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry(commands), { owner: 'boss', store, requireActivation: false });
  const out = toPlain(await handle({ text: 'jarvis help', sender: 'boss', chatId: 'g@g.us', level: 'group', isAdmin: true }));
  const lines = out.split('\n');
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at('Commands') < at('For group admins'), 'everyday commands come first');
  assert.ok(at('For group admins') < at('For the owner'), 'then admin-level, then owner-only');
  assert.ok(at('- note:') < at('For group admins'), 'note is something anyone can use');
  assert.ok(at('- schedule:') > at('For group admins') && at('- schedule:') < at('For the owner'));
  assert.ok(at('- shutdown:') > at('For the owner'), 'lifecycle switches sit under the owner heading');
  store.close();
});

test('help: a section with nothing in it is not printed', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry(commands), { owner: 'boss', store, requireActivation: false });
  const out = toPlain(await handle({ text: 'jarvis help', sender: 'someone', chatId: 'g@g.us', level: 'group' }));
  assert.doesNotMatch(out, /For the owner/); // a plain member has none of those
  assert.match(out, /- note:/);
  store.close();
});
