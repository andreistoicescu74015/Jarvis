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

test('parse: the addressed flag parses a bare command without a prefix', () => {
  assert.deepEqual(parse('ping milk', 'jarvis', { addressed: true }), {
    command: 'ping',
    args: ['milk'],
    rest: 'milk',
  });
  assert.equal(parse('ping milk'), null); // without the flag (or prefix) it is ignored
});

test('parse: tolerates any whitespace between prefix and command (tab, NBSP)', () => {
  const tab = String.fromCharCode(9);
  const nbsp = String.fromCharCode(160);
  assert.deepEqual(parse('jarvis' + tab + 'ping'), { command: 'ping', args: [], rest: '' });
  assert.deepEqual(parse('jarvis' + nbsp + 'note add x'), { command: 'note', args: ['add', 'x'], rest: 'add x' });
  assert.equal(parse('jarvisping'), null); // no whitespace boundary -> not addressed
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
  assert.match(sent[0].text, /Unknown command frobnicate/);
});

test('dispatch: a mistyped command is suggested (corrected line), never auto-run', async () => {
  const sent = await run('jarvis pingg');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Did you mean .*jarvis ping.*Type it to run/);
  assert.doesNotMatch(sent[0].text, /pong/); // a suggestion, not an execution
});

test('dispatch: a mistyped command keeps the original arguments in the suggestion', async () => {
  const sent = await run('jarvis halp me now'); // halp -> help, args preserved
  assert.match(sent[0].text, /Did you mean .*jarvis help me now/);
});

test('dispatch: a non-prefixed message is ignored', async () => {
  assert.deepEqual(await run('just chatting'), []);
});

test('dispatch: an addressed message (e.g. @mention) runs without a prefix', async () => {
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: createDispatcher(createRegistry([ping])) });
  await app.start();
  await adapter.receive({ text: 'ping', addressed: true });
  assert.deepEqual(adapter.sent, [{ chatId: 'test-chat', text: 'pong' }]);
});

test('dispatch: a throwing command is isolated - logged, never posted to chat', async () => {
  const boom = {
    name: 'boom',
    summary: 'throws',
    run: () => {
      throw new Error('kaboom');
    },
  };
  const errors = [];
  const log = { debug() {}, info() {}, warn() {}, error: (msg, fields) => errors.push({ msg, fields }) };
  const adapter = createTestAdapter();
  const app = createApp(adapter, { handle: createDispatcher(createRegistry([boom]), { log }) });
  await app.start();
  await adapter.receive({ text: 'jarvis boom' });

  assert.deepEqual(adapter.sent, []); // the failure never reaches the chat
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /command "boom" failed/);
  assert.equal(errors[0].fields.error, 'kaboom');
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

test('dispatch: a command requiring an absent capability is reported unavailable', async () => {
  const needs = { name: 'needs', summary: 'needs lifecycle', requires: ['lifecycle'], run: () => 'ran' };
  const without = createDispatcher(createRegistry([needs]));
  assert.match(await without({ text: 'jarvis needs', sender: 'x' }), /unavailable here/i);
  const withCap = createDispatcher(createRegistry([needs]), { lifecycle: {} });
  assert.equal(await withCap({ text: 'jarvis needs', sender: 'x' }), 'ran');
});

test('dispatch: a command is never handed a raw send (unattended output goes through the scheduler)', async () => {
  // A command with `send` could post into a chat the activation gate would refuse, bypassing the
  // deliver path every proactive message goes through. Nothing used it, so nothing gets it.
  let seen;
  const probe = { name: 'probe', summary: 'p', run: (ctx) => { seen = ctx; return 'ok'; } };
  const handle = createDispatcher(createRegistry([probe]), { send: () => 'sent' });
  assert.equal(await handle({ text: 'jarvis probe', sender: 'u', level: 'private', chatId: 'dm' }), 'ok');
  assert.equal(seen.send, undefined);
  assert.equal(typeof seen.listGroups, 'function'); // the read-only platform capabilities stay
});
