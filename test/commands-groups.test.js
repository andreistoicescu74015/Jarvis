import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
import { createLinks } from '../src/core/links.js';
import groups from '../src/commands/groups.js';
import { toPlain } from '../src/core/format.js';

test('groups: lists the known groups with ids, sorted by name', async () => {
  const listGroups = async () => [
    { id: '123-1@g.us', name: 'Study' },
    { id: '456-2@g.us', name: 'Friends' },
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', listGroups });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' }));
  assert.match(out, /Groups \(2\)/);
  assert.match(out, /- Friends 456-2@g\.us\n- Study 123-1@g\.us/); // alphabetical
});

test('groups: is owner-only', async () => {
  const handle = createDispatcher(createRegistry([groups]), {
    owner: 'boss',
    listGroups: async () => [{ id: 'x@g.us', name: 'y' }],
  });
  assert.match(await handle({ text: 'jarvis groups', sender: 'rando', level: 'private' }), /Not allowed: owner only/);
});

test('groups: reports none when the platform exposes no groups (e.g. CLI)', async () => {
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss' }); // no listGroups injected
  assert.match(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' }), /No groups found/);
});

// --- activation (ADR-0008): the owner authorizes a group ---
const twoGroups = async () => [
  { id: 'a@g.us', name: 'Alpha' },
  { id: 'b@g.us', name: 'Beta' },
];

test('groups: the list tags each group active/inactive when a store is configured', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: twoGroups });
  await handle({ text: 'jarvis groups activate b@g.us', sender: 'boss', level: 'private' });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' }));
  assert.match(out, /Alpha a@g\.us \(inactive\)/);
  assert.match(out, /Beta b@g\.us \(active\)/);
  store.close();
});

test('groups: owner activates a group remotely by id, then deactivates it', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: twoGroups });

  const on = toPlain(await handle({ text: 'jarvis groups activate a@g.us', sender: 'boss', level: 'private' }));
  assert.match(on, /Activated Jarvis in Alpha/);
  assert.equal(createActivation(store).isActive('a@g.us'), true);

  const again = toPlain(await handle({ text: 'jarvis groups activate a@g.us', sender: 'boss', level: 'private' }));
  assert.match(again, /already active/);

  const off = toPlain(await handle({ text: 'jarvis groups deactivate a@g.us', sender: 'boss', level: 'private' }));
  assert.match(off, /Deactivated Jarvis in Alpha/);
  assert.equal(createActivation(store).isActive('a@g.us'), false);
  store.close();
});

test('groups: activate rejects an unknown id and needs an id from a private chat', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: twoGroups });

  const bad = toPlain(await handle({ text: 'jarvis groups activate z@g.us', sender: 'boss', level: 'private' }));
  assert.match(bad, /No such group/);

  const noId = toPlain(await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'private' }));
  assert.match(noId, /name it/i);
  store.close();
});

test('groups: groups by community and shows link clusters', async () => {
  const store = createStore({ path: ':memory:' });
  const activation = createActivation(store);
  activation.activate('gA@g.us', 'boss');
  activation.activate('gB@g.us', 'boss');
  const links = createLinks(store, {
    isActivated: (id) => activation.isActive(id),
    clearNamespace: (ns) => store.clearNamespace(ns),
  });
  links.accept(links.propose('gA@g.us'), 'gB@g.us'); // link gA + gB into one overlay
  const listGroups = async () => [
    { id: 'gA@g.us', name: 'Alpha', isCommunity: false },
    { id: 'gB@g.us', name: 'Beta', isCommunity: false },
    { id: 'c@g.us', name: 'Class', community: 'c@g.us', isCommunity: true }, // a community's announcement group
    { id: 's@g.us', name: 'Sub', community: 'c@g.us', isCommunity: false }, // a sub-group of it
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Community Class/); // a community header, named by its announcement group
  assert.match(out, /\[community\]/); // the announcement group is tagged
  assert.match(out, /Linked together/);
  assert.match(out, /Alpha \+ Beta|Beta \+ Alpha/); // gA and gB shown as one cluster
  store.close();
});
