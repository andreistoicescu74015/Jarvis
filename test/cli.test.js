import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createApp } from '../src/core/app.js';
import { createCliAdapter } from '../src/cli/adapter.js';

function mockIO(lines) {
  const input = Readable.from(lines.map((l) => `${l}\n`));
  const state = { text: '' };
  const output = new Writable({
    write(chunk, _enc, cb) {
      state.text += chunk.toString();
      cb();
    },
  });
  return { input, output, state };
}

test('cli adapter: feeds stdin lines as messages, writes replies, drains on EOF', async () => {
  const io = mockIO(['hello', 'world']);
  const adapter = createCliAdapter({ input: io.input, output: io.output });
  const app = createApp(adapter, { handle: (msg) => `echo: ${msg.text}` });
  await app.start(); // resolves on EOF, after draining the queue
  assert.equal(io.state.text, 'echo: hello\necho: world\n');
});

test('cli adapter: normalizes the inbound message shape', async () => {
  const io = mockIO(['hi']);
  let received;
  const adapter = createCliAdapter({ input: io.input, output: io.output });
  const app = createApp(adapter, {
    handle: (msg) => {
      received = msg;
      return null;
    },
  });
  await app.start();
  assert.equal(received.kind, 'message');
  assert.equal(received.level, 'private');
  assert.equal(received.fromMe, false);
  assert.equal(received.text, 'hi');
});

test('cli adapter: blank lines are ignored', async () => {
  const io = mockIO(['', '   ', 'real']);
  const adapter = createCliAdapter({ input: io.input, output: io.output });
  const app = createApp(adapter, { handle: (msg) => msg.text });
  await app.start();
  assert.equal(io.state.text, 'real\n');
});
