import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createActivation } from '../src/core/activation.js';
import { toPlain } from '../src/core/format.js';
import status from '../src/commands/status.js';
import note from '../src/commands/note.js';
import rule from '../src/commands/rule.js';
import schedule from '../src/commands/schedule.js';
import whitelist from '../src/commands/whitelist.js';
import blacklist from '../src/commands/blacklist.js';

const GROUP = 'g@g.us';
function setup(opts = {}) {
  const store = createStore({ path: ':memory:' });
  const scheduler = createScheduler(store);
  const handle = createDispatcher(createRegistry([status, note, rule, schedule, whitelist, blacklist]), {
    owner: 'boss', store, scheduler, ...opts,
  });
  const as = (sender, text, over = {}) =>
    handle({ text, sender, chatId: GROUP, level: 'group', isAdmin: true, ...over }).then(toPlain);
  return { store, handle, as };
}

test('status: one answer to how the chat is set up', async () => {
  const { store, as } = setup();
  createActivation(store).activate(GROUP, 'boss');
  await as('boss', 'jarvis note add unu');
  await as('boss', 'jarvis note add doi');
  await as('boss', 'jarvis schedule in 2h stand-up');
  await as('boss', 'jarvis schedule disable s1');
  await as('boss', 'jarvis rule add meniu supa');

  const out = await as('boss', 'jarvis status');
  assert.match(out, /Jarvis is on here/);
  assert.match(out, /Who may use me: everyone/);
  assert.match(out, /General questions: not answered/);
  assert.match(out, /2 notes/);
  assert.match(out, /1 scheduled \(1 paused\)/);
  assert.match(out, /1 auto-reply/);
  store.close();
});

test('status: an inactive group, and one live only through its community', async () => {
  const { store, as } = setup({ requireActivation: false });
  assert.match(await as('boss', 'jarvis status'), /Jarvis is off here/);
  createActivation(store).activate('c@g.us', 'boss'); // the community umbrella, not this group
  const via = await as('boss', 'jarvis status', { community: 'c@g.us' });
  assert.match(via, /Jarvis is on, through its community/);
  store.close();
});

test('status: reports who the bot-wide list actually lets in', async () => {
  const { store, as } = setup();
  createActivation(store).activate(GROUP, 'boss');
  await as('boss', 'jarvis whitelist * enable'); // empty whitelist = admins only
  assert.match(await as('boss', 'jarvis status'), /Who may use me: admins only/);
  await as('boss', 'jarvis whitelist * add 40711');
  await as('boss', 'jarvis whitelist * add 40722');
  assert.match(await as('boss', 'jarvis status'), /Who may use me: 2 listed people, plus admins/);
  await as('boss', 'jarvis whitelist * disable');
  assert.match(await as('boss', 'jarvis status'), /Who may use me: everyone/);
  store.close();
});

test('status: reports a blacklist in the same plain words', async () => {
  const { store, as } = setup();
  createActivation(store).activate(GROUP, 'boss');
  await as('boss', 'jarvis blacklist * add 40711');
  await as('boss', 'jarvis blacklist * enable');
  assert.match(await as('boss', 'jarvis status'), /Who may use me: everyone except 1/);
  await as('boss', 'jarvis blacklist * add *'); // barring everyone leaves only the admins
  assert.match(await as('boss', 'jarvis status'), /Who may use me: admins only/);
  store.close();
});

test('status: says nothing is held before the chat has accumulated anything', async () => {
  const { store, as } = setup();
  assert.match(await as('boss', 'jarvis status'), /Holding: nothing yet/);
  store.close();
});

test('status: a plain member cannot read the chat configuration', async () => {
  const { store, as } = setup();
  assert.match(await as('member', 'jarvis status', { isAdmin: false }), /Not allowed: owner or a group admin only/);
  store.close();
});

test('status: with nothing wired it says so instead of printing an empty heading', async () => {
  const handle = createDispatcher(createRegistry([status]), { owner: 'boss' }); // no store, no scheduler
  const out = toPlain(await handle({ text: 'jarvis status', sender: 'boss', chatId: GROUP, level: 'group', isAdmin: true }));
  assert.equal(out, 'Nothing to report about this chat.');
});

test('status: in a private chat there is no activation and no admins to mention', async () => {
  const { store, handle } = setup();
  const dm = (text) => handle({ text, sender: 'boss', chatId: 'boss', level: 'private' }).then(toPlain);
  await dm('jarvis note add ceva');
  const out = await dm('jarvis status');
  assert.doesNotMatch(out, /Jarvis is on|off here/); // a private chat is never gated
  assert.match(out, /Who may use me: only me/); // the owner's DM lockdown, said plainly
  assert.doesNotMatch(out, /plus admins/); // there are none here
  assert.match(out, /1 note/);
  store.close();
});
