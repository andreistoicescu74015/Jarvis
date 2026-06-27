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

test('ai command: the owner turns chatbot mode on and off for a chat; status reflects it', async () => {
  const { store, handle } = setup({ ai: { translate: async () => ({ commands: [], answer: null }) } }); // a provider is wired (available)
  const chat = { sender: 'boss', level: 'group', chatId: 'g@g.us' };
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /Chatbot mode is off here/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai on' })), /Chatbot mode is on/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /Chatbot mode is on here/i);
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai off' })), /Chatbot mode is off/i);
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

test('ai command: the per-chat chatbot opt-in is isolated to its own context', async () => {
  const { store, handle } = setup();
  await handle({ text: 'jarvis ai on', sender: 'boss', level: 'group', chatId: 'gA@g.us' });
  assert.match(toPlain(await handle({ text: 'jarvis ai', sender: 'boss', level: 'group', chatId: 'gA@g.us' })), /on here/i);
  assert.match(toPlain(await handle({ text: 'jarvis ai', sender: 'boss', level: 'group', chatId: 'gB@g.us' })), /off here/i);
  store.close();
});

test('ai command: the status shows token usage once the AI has been used here', async () => {
  const ai = {
    translate: async () => ({
      commands: [{ command: 'ping', args: {} }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    }),
  };
  const { store, handle } = setup({ ai });
  const chat = { sender: 'boss', level: 'group', chatId: 'g@g.us' };
  assert.doesNotMatch(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /Tokens used/i); // none yet
  await handle({ ...chat, text: 'jarvis fa un ping' }); // unknown -> translated -> records usage
  const out = toPlain(await handle({ ...chat, text: 'jarvis ai' }));
  assert.match(out, /Tokens used - here: 60 \(1 call\)/i);
  assert.match(out, /all chats: 60 \(1 call\)/i);
  store.close();
});

test('ai command: with a daily cap set, the status shows the budget and flags when it is reached', async () => {
  const ai = {
    translate: async () => ({
      commands: [{ command: 'ping', args: {} }],
      usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
    }),
  };
  const { store, handle } = setup({ ai, aiDailyCap: 80 });
  const chat = { sender: 'boss', level: 'group', chatId: 'g@g.us' };
  assert.match(toPlain(await handle({ ...chat, text: 'jarvis ai' })), /0 \/ 80 daily cap/i); // shown even at zero spend
  await handle({ ...chat, text: 'jarvis fa un ping' }); // unknown -> translated -> spends 100, over the 80 cap
  const out = toPlain(await handle({ ...chat, text: 'jarvis ai' }));
  assert.match(out, /100 \/ 80 daily cap/i);
  assert.match(out, /paused until tomorrow/i);
  store.close();
});
