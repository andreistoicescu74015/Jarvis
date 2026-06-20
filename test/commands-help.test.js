import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import ping from '../src/commands/ping.js';
import help from '../src/commands/help.js';
import shutdown from '../src/commands/shutdown.js';
import schedule from '../src/commands/schedule.js';

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
