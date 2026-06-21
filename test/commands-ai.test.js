import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { toPlain } from '../src/core/format.js';
import aiCommand from '../src/commands/ai.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

function setup(opts = {}) {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, aiCommand]), { owner: 'boss', store, ...opts });
  return { store, handle };
}

test('ai command: the owner turns translation on and off for a chat; status reflects it', async () => {
  const { store, handle } = setup({ ai: { translate: async () => null } }); // a provider is wired (available)
  const chat = { sender: 'boss', level: 'group', chatId: 'g@g.us' };
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /translation is off here/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai on' })), /translation is on/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /translation is on here/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai off' })), /translation is off/i);
  store.close();
});

test('ai command: it is owner-only (a group admin cannot toggle it)', async () => {
  const { store, handle } = setup();
  const out = toPlain(await handle({ text: 'jarvis ai on', sender: 'u', level: 'group', chatId: 'g@g.us', isAdmin: true }));
  assert.match(out, /Not allowed/i);
  store.close();
});

test('ai command: notes when no AI provider is configured', async () => {
  const { store, handle } = setup(); // no `ai` client wired -> available is false
  const out = toPlain(await handle({ text: 'jarvis ai on', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /No AI provider is configured/i);
  store.close();
});

test('ai command: the per-chat opt-in is isolated to its own context', async () => {
  const { store, handle } = setup();
  await handle({ text: 'jarvis ai on', sender: 'boss', level: 'group', chatId: 'gA@g.us' });
  assert.match(toPlain(await handle({ text: 'jarvis ai', sender: 'boss', level: 'group', chatId: 'gA@g.us' })), /on here/i);
  assert.match(toPlain(await handle({ text: 'jarvis ai', sender: 'boss', level: 'group', chatId: 'gB@g.us' })), /off here/i);
  store.close();
});
