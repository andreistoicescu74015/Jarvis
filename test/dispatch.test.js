import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/core/parse.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createApp } from '../src/core/app.js';
import { createTestAdapter } from './helpers.js';
import ping from '../src/commands/ping.js';
import help from '../src/commands/help.js';

test('parse: ignores text without the prefix', () => {
  assert.equal(parse('hello world'), null);
});

test('parse: extracts command and args', () => {
  assert.deepEqual(parse('jarvis note add milk'), {
    command: 'note',
    args: ['add', 'milk'],
    rest: 'add milk',
  });
});

test('parse: prefix is case-insensitive and the command is lowercased', () => {
  assert.deepEqual(parse('JARVIS Ping'), { command: 'ping', args: [], rest: '' });
});

test('parse: bare prefix yields an empty command', () => {
  assert.deepEqual(parse('jarvis'), { command: '', args: [], rest: '' });
});

async function run(text, commands = [ping, help]) {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: createDispatcher(createRegistry(commands)) });
  await app.start();
  await adapter.receive({ text });
  return adapter.sent;
}

test('dispatch: ping -> pong', async () => {
  assert.deepEqual(await run('jarvis ping'), [{ chatId: 'test-chat', text: 'pong' }]);
});

test('dispatch: help lists commands from the registry', async () => {
  const sent = await run('jarvis help');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /- ping: Check the bot is alive\./);
  assert.match(sent[0].text, /- help: List available commands\./);
});

test('dispatch: unknown command returns a hint', async () => {
  const sent = await run('jarvis frobnicate');
  assert.match(sent[0].text, /Unknown command "frobnicate"/);
});

test('dispatch: a non-prefixed message is ignored', async () => {
  assert.deepEqual(await run('just chatting'), []);
});

test('dispatch: a throwing command is isolated', async () => {
  const boom = {
    name: 'boom',
    summary: 'throws',
    run: () => {
      throw new Error('kaboom');
    },
  };
  const sent = await run('jarvis boom', [boom]);
  assert.match(sent[0].text, /Command "boom" failed: kaboom/);
});

test('registry: rejects duplicate command names', () => {
  assert.throws(() => createRegistry([ping, ping]), /duplicate/);
});

test('dispatch: a command can reply via ctx.reply (lines collected and joined)', async () => {
  const chatty = {
    name: 'chatty',
    summary: 'uses ctx.reply',
    run: (ctx) => {
      ctx.reply('line 1');
      ctx.reply('line 2');
    },
  };
  const sent = await run('jarvis chatty', [chatty]);
  assert.deepEqual(sent, [{ chatId: 'test-chat', text: 'line 1\nline 2' }]);
});
