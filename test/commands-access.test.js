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

test('access cmd: a non-command target errors instead of showing a phantom empty rule', async () => {
  const { boss } = setup();
  // "blacklist enable" - the command name was dropped (a user typo, or an AI translation of
  // "enable the blacklist" with no command). "enable" is not a command, so it must error clearly.
  assert.match(await boss('jarvis blacklist enable'), /No such command: enable/i);
  assert.match(await boss('jarvis whitelist disable'), /No such command: disable/i);
  // a real command target still shows its rule
  assert.match(await boss('jarvis blacklist note'), /blacklist for "note"/i);
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

test('access cmd: the list commands need the owner or a group admin', async () => {
  const { as } = setup(); // `as` is a non-admin group member
  assert.match(await as('rando', 'jarvis blacklist ping add bob'), /Not allowed: owner or a group admin only/);
});

test('access cmd: a group admin manages only their own chat (no cross-context)', async () => {
  const { handle } = setup(); // env owner 'boss'
  const admin = (text, over = {}) => handle({ text, sender: 'adm', chatId: 'c1', level: 'group', isAdmin: true, ...over });

  // the admin blocks bob from ping here, and it applies in this chat only
  assert.match(await admin('jarvis blacklist ping add bob'), /Added bob/i);
  assert.match(await admin('jarvis blacklist ping enable'), /Turned on the blacklist/i);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c2', level: 'group' }), 'pong'); // not in another group
});

test('access cmd: an admin can gate the whole bot, but only in their own chat', async () => {
  const { handle } = setup();
  const admin = (text) => handle({ text, sender: 'adm', chatId: 'c1', level: 'group', isAdmin: true });
  await admin('jarvis blacklist * add rando');
  await admin('jarvis blacklist * enable');
  assert.match(await handle({ text: 'jarvis ping', sender: 'rando', chatId: 'c1', level: 'group' }), /only answer certain people/i); // blocked here
  assert.equal(await handle({ text: 'jarvis ping', sender: 'rando', chatId: 'c2', level: 'group' }), 'pong'); // not elsewhere
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

test('access cmd: "list"/"show" (or no target) give the rules overview - where the AI lands for "what is active here"', async () => {
  const { boss } = setup();
  await boss('jarvis blacklist ping add bob');
  await boss('jarvis blacklist ping enable');
  // A bare command, or the natural words "list"/"show", all show the overview - never "No such command".
  for (const text of ['jarvis blacklist', 'jarvis blacklist list', 'jarvis blacklist show']) {
    const out = await boss(text);
    assert.match(out, /"ping".*bob/s, `${text} should show the overview`);
    assert.doesNotMatch(out, /No such command/i, `${text} must not be treated as a target`);
  }
});

test('access cmd: "*" target gates the whole bot in this context; owner bypasses', async () => {
  const { boss, as } = setup();
  assert.match(await boss('jarvis whitelist * enable'), /Turned on the whitelist for the whole bot/i);
  assert.match(await as('rando', 'jarvis ping', 'c1'), /only answer certain people/i); // blocked here (empty whitelist)
  assert.equal(await as('boss', 'jarvis ping', 'c1'), 'pong'); // owner bypass
  assert.equal(await as('rando', 'jarvis ping', 'cZ'), 'pong'); // another context is unaffected
});

test('access cmd: a "*" person blocks everyone here; the owner still works', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist note add *');
  await boss('jarvis blacklist note enable');
  assert.equal(await as('rando', 'jarvis note list', 'c1'), undefined); // everyone blocked here
  assert.match(await as('boss', 'jarvis note list', 'c1'), /No notes yet/i); // owner bypasses
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

test('access cmd: a rule set in one group does not apply in another', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist ping add bob', 'gA');
  await boss('jarvis blacklist ping enable', 'gA');
  assert.equal(await as('bob', 'jarvis ping', 'gA'), undefined); // blocked in gA
  assert.equal(await as('bob', 'jarvis ping', 'gB'), 'pong'); // not in gB (set it where it applies)
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

test('access cmd: the command target is case-insensitive (matches lowercase command names)', async () => {
  const { boss, as } = setup();
  await boss('jarvis blacklist Ping add bob'); // mixed-case target
  await boss('jarvis blacklist PING enable');
  assert.equal(await as('bob', 'jarvis ping'), undefined); // resolved to "ping" and applied
});

test('access cmd: list members are shown by their readable user part, not a raw jid', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, owner, whitelist, blacklist]), { store, owner: 'boss' });
  await handle({ text: 'jarvis blacklist ping add 40712345678@s.whatsapp.net', sender: 'boss', chatId: 'c1', level: 'group' });
  const out = await handle({ text: 'jarvis blacklist ping', sender: 'boss', chatId: 'c1', level: 'group' });
  assert.match(out, /40712345678/);
  assert.doesNotMatch(out, /@s\.whatsapp\.net/);
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

test('access cmd: addressing the bot by @mention does not target the bot itself', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, owner, whitelist, blacklist]), { store, owner: 'boss' });
  // The bot is addressed by @mention AND a victim is @mentioned: WhatsApp lists the bot's own
  // jid among the mentions (here first). The named target must be the victim, not the bot.
  assert.match(
    await handle({
      text: 'blacklist ping add @victim',
      addressed: true,
      self: ['5@s.whatsapp.net'],
      mentionedJid: ['5@s.whatsapp.net', '99@s.whatsapp.net'],
      sender: 'boss',
      chatId: 'c1',
      level: 'group',
    }),
    /Added 99/i,
  );
  await handle({ text: 'jarvis blacklist ping enable', sender: 'boss', chatId: 'c1', level: 'group' });
  assert.equal(await handle({ text: 'jarvis ping', sender: '99@s.whatsapp.net', chatId: 'c1', level: 'group' }), undefined);
  assert.equal(await handle({ text: 'jarvis ping', sender: 'other', chatId: 'c1', level: 'group' }), 'pong');
});

test('access cmd: a group admin bypasses the access lists (always has access where Jarvis runs)', async () => {
  const { boss, handle } = setup();
  await boss('jarvis blacklist ping add adm');
  await boss('jarvis blacklist ping add bob');
  await boss('jarvis blacklist ping enable');
  // a non-admin on the blacklist is blocked here...
  assert.equal(await handle({ text: 'jarvis ping', sender: 'bob', chatId: 'c1', level: 'group' }), undefined);
  // ...but an admin passes regardless of the list (their group, their access)
  assert.equal(await handle({ text: 'jarvis ping', sender: 'adm', chatId: 'c1', level: 'group', isAdmin: true }), 'pong');
});
