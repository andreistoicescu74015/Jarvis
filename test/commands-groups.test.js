import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
import { createLinks } from '../src/core/links.js';
import { createAccessPolicy } from '../src/core/access.js';
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

test('groups: shows member counts when the platform reports them', async () => {
  const listGroups = async () => [
    { id: 'a@g.us', name: 'Alpha', size: 88 },
    { id: 'b@g.us', name: 'Beta' }, // no size reported
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', listGroups });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' }));
  assert.match(out, /Alpha a@g\.us \(88\)/); // count shown
  assert.match(out, /Beta b@g\.us(?:\n|$)/); // Beta has no count appended
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
  assert.match(bad, /not in a group called/i);

  const noId = toPlain(await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'private' }));
  assert.match(noId, /name it/i);
  store.close();
});

test('groups: a group can be named by NAME, so nobody has to retype a jid on a phone', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: twoGroups });
  const on = toPlain(await handle({ text: 'jarvis groups activate Beta', sender: 'boss', level: 'private' }));
  assert.match(on, /Activated Jarvis in Beta/);
  assert.equal(store.scoped('activation').has('b@g.us'), true); // the right group, resolved from its name
  // A distinctive part of the name is enough, and matching ignores case.
  const off = toPlain(await handle({ text: 'jarvis groups deactivate bet', sender: 'boss', level: 'private' }));
  assert.match(off, /Deactivated Jarvis in Beta/);
  store.close();
});

test('groups: a name that fits more than one group is refused, never guessed', async () => {
  // The same argument drives `deactivate`, which tears a group down - guessing here is not an option.
  const store = createStore({ path: ':memory:' });
  const many = async () => [
    { id: 'a@g.us', name: 'Proiect licenta' },
    { id: 'b@g.us', name: 'Proiect PA' },
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: many });
  const out = toPlain(await handle({ text: 'jarvis groups deactivate Proiect', sender: 'boss', level: 'private' }));
  assert.match(out, /fits 2 groups/);
  assert.match(out, /Proiect licenta/);
  assert.equal(store.scoped('activation').has('a@g.us'), false); // nothing was touched
  store.close();
});

test('groups: a name cannot be resolved while the group list is unreachable', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: async () => [] });
  const out = toPlain(await handle({ text: 'jarvis groups activate Beta', sender: 'boss', level: 'private' }));
  assert.match(out, /can't fetch the group list/i);
  store.close();
});

test('groups: a long membership list is capped, saying how many it left out', async () => {
  const store = createStore({ path: ':memory:' });
  const lots = async () => Array.from({ length: 42 }, (_, n) => ({ id: `g${n}@g.us`, name: `Grup ${String(n).padStart(2, '0')}` }));
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: lots });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' }));
  assert.match(out, /Showing 30 of 42/);
  assert.ok(out.split('\n').length < 36, 'the listing stays within one readable message');
  store.close();
});

const communityGroups = async () => [
  { id: 'c@g.us', name: 'Class', community: 'c@g.us', isCommunity: true }, // announcement group
  { id: 's@g.us', name: 'Sub', community: 'c@g.us', isCommunity: false }, // sub-group of it
];

test('groups: a community id gets the gate-only umbrella - nothing is posted anywhere', async () => {
  const store = createStore({ path: ':memory:' });
  const sent = [];
  const handle = createDispatcher(createRegistry([groups]), {
    owner: 'boss',
    store,
    listGroups: communityGroups,
    send: (target, text) => sent.push({ target, text }),
  });
  const out = toPlain(await handle({ text: 'jarvis groups activate c@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /across the Class community/);
  assert.match(out, /Nothing was posted/);
  assert.equal(sent.length, 0); // gate-only: NO announcement, into the community or anywhere (ban-safety)
  assert.equal(createActivation(store).isActive('c@g.us'), true);
  // no admins-only access reset was pushed onto the community (only the unrelated private lockdown exists)
  assert.equal(createAccessPolicy(store).all().filter((r) => r.context === 'c@g.us').length, 0);
  // deactivate mirrors it, in place, with the individually-activated caveat
  const off = toPlain(await handle({ text: 'jarvis groups deactivate c@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(off, /Deactivated Jarvis across the Class community/);
  assert.equal(createActivation(store).isActive('c@g.us'), false);
  store.close();
});

test('groups: activate run inside the announcement chat takes the umbrella path (no announcement)', async () => {
  const store = createStore({ path: ':memory:' });
  const sent = [];
  const handle = createDispatcher(createRegistry([groups]), {
    owner: 'boss',
    store,
    listGroups: async () => [], // even with no membership list, the chat itself identifies the community
    send: (target, text) => sent.push({ target, text }),
  });
  const out = toPlain(
    await handle({ text: 'jarvis groups activate', sender: 'boss', level: 'community', chatId: 'c@g.us', community: 'c@g.us' }),
  );
  assert.match(out, /across the .* community/);
  assert.equal(sent.length, 0); // confirmed here (the command reply), nothing pushed elsewhere
  assert.equal(createActivation(store).isActive('c@g.us'), true);
  store.close();
});

test('groups: deactivating an umbrella-covered sub-group explains where the switch is', async () => {
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('c@g.us', 'boss'); // umbrella on; the sub-group has NO own entry
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups: communityGroups });
  const out = toPlain(await handle({ text: 'jarvis groups deactivate s@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /active via its community umbrella/);
  assert.match(out, /community deactivate c@g\.us/); // points at the switch that actually works
  assert.equal(createActivation(store).isActive('c@g.us'), true); // the umbrella itself is untouched
  // an unrelated inactive group still gets the plain message
  const plain = toPlain(await handle({ text: 'jarvis groups deactivate s@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(plain, /umbrella/); // (still umbrella-covered)
  store.close();
});

test('groups: a sub-group active via its community umbrella is tagged so', async () => {
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('c@g.us', 'boss'); // activate the community (umbrella), by its own id
  const listGroups = async () => [
    { id: 'c@g.us', name: 'Class', community: 'c@g.us', isCommunity: true }, // announcement group
    { id: 's@g.us', name: 'Sub', community: 'c@g.us', isCommunity: false }, // sub-group of it
    { id: 'g@g.us', name: 'Solo', isCommunity: false }, // unrelated standalone group
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', store, listGroups });
  const out = toPlain(await handle({ text: 'jarvis groups', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Class c@g\.us \(active\)/); // announcement group: active via its own id
  assert.match(out, /Sub s@g\.us \(active via community\)/); // sub-group: active via the umbrella
  assert.match(out, /Solo g@g\.us \(inactive\)/); // unrelated group: still inactive
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

test('groups: a named id is refused when the group list is unavailable (never guessed)', async () => {
  // Regression: with the membership list unreadable (a fetch error reports []), a named COMMUNITY id
  // silently degraded to plain-group semantics - an announcement + access reset pushed INTO the
  // community on activate, or the full destructive teardown on deactivate. Refuse instead.
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('c@g.us', 'boss'); // an active community the owner might target
  const sent = [];
  const handle = createDispatcher(createRegistry([groups]), {
    owner: 'boss',
    store,
    listGroups: async () => [], // the adapter's error value (socket down, fetch failed)
    send: (target, text) => sent.push({ target, text }),
  });
  const off = toPlain(await handle({ text: 'jarvis groups deactivate c@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(off, /can't fetch the group list right now/i);
  assert.equal(createActivation(store).isActive('c@g.us'), true); // nothing was torn down
  const on = toPlain(await handle({ text: 'jarvis groups activate x@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(on, /can't fetch the group list right now/i);
  assert.equal(sent.length, 0); // and nothing was announced anywhere
  store.close();
});
