import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { toPlain } from '../src/core/format.js';
import rule from '../src/commands/rule.js';
import ping from '../src/commands/ping.js';
import alias from '../src/commands/alias.js';

test('rule dispatch: a keyword auto-reply fires for anyone addressing the bot, with templating', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([rule, ping, alias]), { owner: 'boss', store });
  // the owner defines an auto-reply in this chat
  await handle({ text: 'jarvis rule add greet Hi {{sender}}, welcome', sender: 'boss', chatId: 'gA', level: 'group' });
  // a regular member triggers it; {{sender}} is filled from the triggering message
  const out = toPlain(await handle({ text: 'jarvis greet', sender: 'u', chatId: 'gA', level: 'group' }));
  assert.match(out, /Hi u, welcome/);
  // chat-scoped: the same keyword is undefined in another chat (falls through, no auto-reply)
  const other = toPlain((await handle({ text: 'jarvis greet', sender: 'u', chatId: 'gB', level: 'group' })) ?? '');
  assert.doesNotMatch(other, /welcome/);
  store.close();
});

test('rule dispatch: a rule never shadows a real command or an alias', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([rule, ping, alias]), { owner: 'boss', store });
  // a real command name is refused as a keyword by the command itself
  assert.match(
    toPlain(await handle({ text: 'jarvis rule add ping nope', sender: 'boss', chatId: 'gA', level: 'group' })),
    /built-in command/,
  );
  // an alias is checked before a rule: define alias gm -> ping, plus a same-named rule that must NOT win
  await handle({ text: 'jarvis alias add gm ping', sender: 'boss', chatId: 'gA', level: 'group' });
  await handle({ text: 'jarvis rule add gm SHOULD-NOT-FIRE', sender: 'boss', chatId: 'gA', level: 'group' });
  const out = toPlain(await handle({ text: 'jarvis gm', sender: 'boss', chatId: 'gA', level: 'group' }));
  assert.match(out, /pong/); // the alias (-> ping) fired
  assert.doesNotMatch(out, /SHOULD-NOT-FIRE/); // the rule did not
  store.close();
});
