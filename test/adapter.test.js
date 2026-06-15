import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/core/app.js';
import { createTestAdapter } from './helpers.js';

test('reply from handle is sent back to the originating chat', async () => {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: (msg) => `you said: ${msg.text}` });
  await app.start();
  await adapter.receive({ text: 'hello', chatId: 'c1' });
  assert.deepEqual(adapter.sent, [{ chatId: 'c1', text: 'you said: hello' }]);
});

test('a null or empty reply sends nothing', async () => {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: () => null });
  await app.start();
  await adapter.receive({ text: 'whatever' });
  assert.deepEqual(adapter.sent, []);
});

test('messages from the bot itself are ignored', async () => {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: () => 'should not send' });
  await app.start();
  await adapter.receive({ text: 'hi', fromMe: true });
  assert.deepEqual(adapter.sent, []);
});

test('handle receives the normalized inbound message', async () => {
  const adapter = createTestAdapter();
  let received;
  const app = createApp(adapter, {
    handle: (msg) => {
      received = msg;
      return null;
    },
  });
  await app.start();
  await adapter.receive({ text: 'x', chatId: 'g1', sender: 'u1', level: 'group' });
  assert.equal(received.kind, 'message');
  assert.equal(received.level, 'group');
  assert.equal(received.sender, 'u1');
  assert.equal(received.chatId, 'g1');
});

test('an async handler is awaited before sending', async () => {
  const adapter = createTestAdapter();
  const app = createApp(adapter, {
    handle: async (msg) => {
      await Promise.resolve();
      return `async: ${msg.text}`;
    },
  });
  await app.start();
  await adapter.receive({ text: 'go', chatId: 'c2' });
  assert.deepEqual(adapter.sent, [{ chatId: 'c2', text: 'async: go' }]);
});

test('createApp requires a handle function', () => {
  const adapter = createTestAdapter();
  assert.throws(() => createApp(adapter, {}), TypeError);
});
