import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { toPlain } from '../src/core/format.js';
import alias from '../src/commands/alias.js';
import reset from '../src/commands/reset.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

function setup() {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, alias, reset]), { owner: 'boss', store });
  return { store, handle };
}
const boss = (text) => ({ text, sender: 'boss', level: 'private', chatId: 'dm' });

test('alias command: the owner adds, lists, runs, and removes a shortcut', async () => {
  const { store, handle } = setup();
  assert.match(toPlain(await handle(boss('jarvis alias add hi ping'))), /Alias hi -> ping saved/i);
  assert.match(toPlain(await handle(boss('jarvis alias list'))), /hi -> ping/);
  assert.match(toPlain(await handle(boss('jarvis alias'))), /hi -> ping/); // bare command = list
  assert.equal(toPlain(await handle(boss('jarvis hi'))), 'pong'); // the defined alias expands and runs
  assert.match(toPlain(await handle(boss('jarvis alias remove hi'))), /Removed alias hi/i);
  assert.match(toPlain(await handle(boss('jarvis alias list'))), /No aliases defined/i);
  assert.match(toPlain(await handle(boss('jarvis alias remove hi'))), /No alias "hi"/i); // already gone
  store.close();
});

test('alias command: it is owner-only (a group admin cannot define one)', async () => {
  const { store, handle } = setup();
  const out = toPlain(await handle({ text: 'jarvis alias add x ping', sender: 'u', level: 'group', chatId: 'g@g.us', isAdmin: true }));
  assert.match(out, /Not allowed/i);
  store.close();
});

test('alias command: refuses a shadowing name, a bad name, a missing target, and an over-long target', async () => {
  const { store, handle } = setup();
  assert.match(toPlain(await handle(boss('jarvis alias add ping note add x'))), /built-in command/i); // shadows `ping`
  assert.match(toPlain(await handle(boss('jarvis alias add * ping'))), /single word/i); // not a single token
  assert.match(toPlain(await handle(boss('jarvis alias add lonely'))), /Usage/i); // a name but no target
  assert.match(toPlain(await handle(boss(`jarvis alias add big ${'x'.repeat(501)}`))), /too long/i);
  store.close();
});

test('alias command: remove with no name, and an unknown subcommand, show usage', async () => {
  const { store, handle } = setup();
  assert.match(toPlain(await handle(boss('jarvis alias remove'))), /Usage:.*alias remove/i);
  assert.match(toPlain(await handle(boss('jarvis alias frobnicate'))), /Usage:.*alias add/i);
  store.close();
});

test('alias command: an alias to a SENSITIVE command is not auto-run - the owner must type the real one', async () => {
  const { store, handle } = setup();
  await handle(boss('jarvis alias add wipe reset')); // `reset` is sensitive (confirm)
  const out = toPlain(await handle(boss('jarvis wipe')));
  assert.match(out, /type .*jarvis reset.* yourself to confirm/i); // gated via the alias path, not executed
  store.close();
});
