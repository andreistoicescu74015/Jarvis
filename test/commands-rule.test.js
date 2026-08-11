import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import rule from '../src/commands/rule.js';
import help from '../src/commands/help.js';

function setup() {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([rule, help]), { owner: 'boss', store });
  return { store, handle };
}
const asOwner = (handle, text) => handle({ text, sender: 'boss', chatId: 'gA', level: 'group' }).then(toPlain);

test('rule cmd: owner adds, lists (bare + explicit), and removes a keyword auto-reply', async () => {
  const { store, handle } = setup();
  assert.match(await asOwner(handle, 'jarvis rule add menu Today: soup'), /saved/i);
  assert.match(await asOwner(handle, 'jarvis rule list'), /menu/);
  assert.match(await asOwner(handle, 'jarvis rule'), /menu/); // bare = list
  assert.match(await asOwner(handle, 'jarvis rule remove menu'), /Removed/);
  assert.match(await asOwner(handle, 'jarvis rule list'), /No auto-replies/i);
  store.close();
});

test('rule cmd: a keyword cannot shadow a built-in command name', async () => {
  const { store, handle } = setup();
  assert.match(await asOwner(handle, 'jarvis rule add help nope'), /built-in command/);
  store.close();
});

test('rule cmd: rejects a bad keyword and an empty reply', async () => {
  const { store, handle } = setup();
  assert.match(await asOwner(handle, 'jarvis rule add'), /Usage/); // no keyword/reply
  store.close();
});

test('rule cmd: needs owner or a group admin', async () => {
  const { store, handle } = setup();
  assert.match(
    await handle({ text: 'jarvis rule add menu x', sender: 'u', chatId: 'gA', level: 'group' }),
    /Not allowed: owner or a group admin/,
  );
  store.close();
});

test('rule: a long list is capped, saying what it left out', async () => {
  const { store, handle } = setup();
  for (let n = 1; n <= 25; n++) await asOwner(handle, `jarvis rule add kw${String(n).padStart(2, '0')} reply ${n}`);
  const out = await asOwner(handle, 'jarvis rule list');
  assert.match(out, /Showing 20 of 25, alphabetically/);
  assert.ok(out.split('\n').length <= 22);
  store.close();
});
