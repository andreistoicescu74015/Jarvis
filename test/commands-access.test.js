import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import ping from '../src/commands/ping.js';
import note from '../src/commands/note.js';
import owner from '../src/commands/owner.js';
import shutdown from '../src/commands/shutdown.js';
import whitelist from '../src/commands/whitelist.js';
import blacklist from '../src/commands/blacklist.js';

/** Dispatcher with the access commands, an env owner ('boss'), and a store. */
function setup() {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, note, owner, shutdown, whitelist, blacklist]), {
    store,
    owner: 'boss',
  });
  const boss = (text, chatId = 'c1') => handle({ text, sender: 'boss', chatId, level: 'group' });
  const as = (sender, text, chatId = 'c1') => handle({ text, sender, chatId, level: 'group' });
  return { handle, boss, as };
}

test('access cmd: blacklist add does not apply until enable, then blocks (silently)', async () => {
  const { boss, as } = setup();
  assert.match(await boss('jarvis blacklist ping add bob'), /Added bob/i);
  assert.equal(await as('bob', 'jarvis ping'), 'pong'); // not enabled yet
  assert.match(await boss('jarvis blacklist ping enable'), /Turned on the blacklist/i);
  assert.equal(await as('bob', 'jarvis ping'), undefined); // now silently blocked
  assert.equal(await as('alice', 'jarvis ping'), 'pong'); // others unaffected
});

test('access cmd: whitelist restricts a command to listed people', async () => {
  const { boss, as } = setup();
  await boss('jarvis whitelist ping add alice');
  await boss('jarvis whitelist ping enable');
  assert.equal(await as('alice', 'jarvis ping'), 'pong');
  assert.equal(await as('bob', 'jarvis ping'), undefined);
});

test('access cmd: disable keeps members, enable restores them', async () => {
  const { boss, as } = setup();
  await boss('jarvis whitelist ping add alice');
  await boss('jarvis whitelist ping enable');
  assert.equal(await as('bob', 'jarvis ping'), undefined);
  assert.match(await boss('jarvis whitelist ping disable'), /Turned off the whitelist/i);
  assert.equal(await as('bob', 'jarvis ping'), 'pong'); // open again
  await boss('jarvis whitelist ping enable');
  assert.equal(await as('bob', 'jarvis ping'), undefined); // restored without re-adding
});

test('access cmd: the list commands are owner-only', async () => {
  const { as } = setup();
  assert.match(await as('rando', 'jarvis blacklist ping add bob'), /Not allowed: owner only/);
});

test('access cmd: lists cannot target owner-only commands or the owner command', async () => {
  const { boss } = setup();
  assert.match(await boss('jarvis blacklist shutdown add bob'), /owner-only/i);
  assert.match(await boss('jarvis whitelist owner add bob'), /cannot be restricted/i);
  assert.match(await boss('jarvis blacklist nope add bob'), /No such command: nope/);
});

test('access cmd: overview and show report state', async () => {
  const { boss } = setup();
  await boss('jarvis blacklist ping add bob');
  await boss('jarvis blacklist ping enable');
  assert.match(await boss('jarvis blacklist'), /"ping".*bob/s);
  assert.match(await boss('jarvis blacklist ping'), /on; bob/);
  assert.match(await boss('jarvis whitelist'), /No whitelist rules/);
});

test('access cmd: "*" target gates the whole bot everywhere; owner bypasses', async () => {
  const { boss, as } = setup();
  assert.match(await boss('jarvis whitelist * enable in *'), /Turned on the whitelist for the whole bot everywhere/i);
  assert.equal(await as('rando', 'jarvis ping', 'cZ'), undefined); // blocked in any chat
  assert.equal(await as('boss', 'jarvis ping', 'cZ'), 'pong'); // owner bypass
});

test('access cmd: "*" person blocks everyone, owner still works', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist note add * in *');
  await boss('jarvis blacklist note enable in *');
  assert.equal(await as('rando', 'jarvis note list', 'cZ'), undefined);
  assert.match(await as('boss', 'jarvis note list', 'cZ'), /No notes yet/i);
});

test('access cmd: clear empties a list and reopens the command', async () => {
  const { boss, as } = setup();
  await boss('jarvis whitelist ping add alice');
  await boss('jarvis whitelist ping enable');
  assert.equal(await as('bob', 'jarvis ping'), undefined);
  assert.match(await boss('jarvis whitelist ping clear'), /Cleared the whitelist/i);
  assert.equal(await as('bob', 'jarvis ping'), 'pong');
});

test('access cmd: remove drops one person while others stay blocked', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist ping add bob');
  await boss('jarvis blacklist ping add alice');
  await boss('jarvis blacklist ping enable');
  assert.equal(await as('bob', 'jarvis ping'), undefined);
  assert.match(await boss('jarvis blacklist ping remove bob'), /Removed bob/i);
  assert.equal(await as('bob', 'jarvis ping'), 'pong'); // freed
  assert.equal(await as('alice', 'jarvis ping'), undefined); // still blocked
});

test('access cmd: "in <chat>" targets another chat only', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist ping add bob in cX');
  await boss('jarvis blacklist ping enable in cX');
  assert.equal(await as('bob', 'jarvis ping', 'cX'), undefined); // blocked there
  assert.equal(await as('bob', 'jarvis ping', 'c1'), 'pong'); // fine here
});

test('access cmd: a person can be named by @mention', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, owner, whitelist, blacklist]), { store, owner: 'boss' });
  await handle({
    text: 'jarvis blacklist ping add @someone',
    sender: 'boss',
    chatId: 'c1',
    level: 'group',
    mentionedJid: ['99@s.whatsapp.net'],
  });
  await handle({ text: 'jarvis blacklist ping enable', sender: 'boss', chatId: 'c1', level: 'group' });
  assert.equal(await handle({ text: 'jarvis ping', sender: '99@s.whatsapp.net', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'other', chatId: 'c1', level: 'group' }), 'pong');
});

test('access cmd: resolveUser canonicalizes a typed number to match a JID sender', async () => {
  const store = createStore({ path: ':memory:' });
  const resolveUser = (t) => {
    const d = String(t).replace(/[^0-9]/g, '');
    return d ? `${d}@s.whatsapp.net` : String(t);
  };
  const handle = createDispatcher(createRegistry([ping, owner, whitelist, blacklist]), { store, owner: 'boss', resolveUser });
  await handle({ text: 'jarvis blacklist ping add 40712345678', sender: 'boss', chatId: 'c1', level: 'group' });
  await handle({ text: 'jarvis blacklist ping enable', sender: 'boss', chatId: 'c1', level: 'group' });
  assert.equal(await handle({ text: 'jarvis ping', sender: '40712345678@s.whatsapp.net', chatId: 'c1', level: 'group' }), undefined);
});

test('access cmd: enabling one mode replaces the other; disable reports when not on', async () => {
  const { boss } = setup();
  await boss('jarvis blacklist ping add bob');
  await boss('jarvis blacklist ping enable');
  await boss('jarvis whitelist ping add alice');
  assert.match(await boss('jarvis whitelist ping enable'), /replaces the blacklist/i);
  assert.match(await boss('jarvis blacklist ping disable'), /not on/i); // blacklist is not the active mode now
});

test('access cmd: the bot itself cannot be added to a list', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, owner, whitelist, blacklist]), { store, owner: 'boss' });
  // by the bot's trigger name
  assert.match(
    await handle({ text: 'jarvis blacklist ping add jarvis', sender: 'boss', chatId: 'c1', level: 'group' }),
    /cannot add the bot/i,
  );
  // by the bot's own account id (carried on the inbound message as `self`)
  assert.match(
    await handle({ text: 'jarvis blacklist ping add 5@s.whatsapp.net', sender: 'boss', chatId: 'c1', level: 'group', self: ['5@s.whatsapp.net'] }),
    /cannot add the bot/i,
  );
  // a normal person is still accepted
  assert.match(
    await handle({ text: 'jarvis blacklist ping add 6@s.whatsapp.net', sender: 'boss', chatId: 'c1', level: 'group', self: ['5@s.whatsapp.net'] }),
    /^Added /,
  );
});
