import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
import community from '../src/commands/community.js';
import { toPlain } from '../src/core/format.js';

const INFO = {
  id: 'c@g.us',
  name: 'Anul 2',
  description: 'Info hub',
  subGroups: [
    { id: 's1@g.us', name: 'General', size: 412 },
    { id: 's2@g.us', name: 'Laborator', size: 88 },
  ],
  reach: 501,
};

/** A fake community capability; `info` records the ids it is asked for. */
const fakeCommunity = (value, seen = []) => ({
  info: async (id) => { seen.push(id); return value; },
  groups: async () => [],
  all: async () => [],
});

test('community: shows the current community structure, bound to the chat by default', async () => {
  const seen = [];
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', community: fakeCommunity(INFO, seen) });
  const out = toPlain(await handle({ text: 'jarvis community', sender: 'boss', level: 'community', chatId: 'c@g.us' }));
  assert.match(out, /Community Anul 2 \(501 members\)/);
  assert.match(out, /Info hub/);
  assert.match(out, /Groups \(2\)/);
  assert.match(out, /- General \(412\)\n- Laborator \(88\)/);
  assert.equal(seen[0], 'c@g.us'); // defaulted to the current chat's community
});

test('community: an explicit id targets another community', async () => {
  const seen = [];
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', community: fakeCommunity(INFO, seen) });
  await handle({ text: 'jarvis community x@g.us', sender: 'boss', level: 'private' });
  assert.equal(seen[0], 'x@g.us');
});

test('community: reports when no community resolves (from a chat, or by id)', async () => {
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', community: fakeCommunity(undefined) });
  const fromChat = toPlain(await handle({ text: 'jarvis community', sender: 'boss', level: 'private' }));
  assert.match(fromChat, /Run this inside a community, or name one/);
  const byId = toPlain(await handle({ text: 'jarvis community z@g.us', sender: 'boss', level: 'private' }));
  assert.match(byId, /No community found for/);
});

test('community: shows a community with no linked sub-groups', async () => {
  const bare = { id: 'c@g.us', name: 'Empty', subGroups: [], reach: 0 };
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', community: fakeCommunity(bare) });
  const out = toPlain(await handle({ text: 'jarvis community', sender: 'boss', level: 'community', chatId: 'c@g.us' }));
  assert.match(out, /Community Empty/);
  assert.match(out, /No linked sub-groups/);
});

test('community: is owner-or-admin only', async () => {
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', community: fakeCommunity(INFO) });
  const denied = await handle({ text: 'jarvis community', sender: 'rando', level: 'community', chatId: 'c@g.us', isAdmin: false });
  assert.match(denied, /Not allowed: owner or a group admin only/);
  const ok = toPlain(await handle({ text: 'jarvis community', sender: 'adm', level: 'community', chatId: 'c@g.us', isAdmin: true }));
  assert.match(ok, /Community Anul 2/);
});

test('community: reports unavailable where the platform has no community capability (e.g. CLI)', async () => {
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss' }); // no community injected
  assert.match(await handle({ text: 'jarvis community', sender: 'boss', level: 'private' }), /unavailable here/);
});

// --- community-wide activation (the umbrella) ---

test('community: the owner activates Jarvis across the whole community', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', store, community: fakeCommunity(INFO) });
  const msg = { text: 'jarvis community activate', sender: 'boss', level: 'community', chatId: 'c@g.us', community: 'c@g.us' };
  const out = toPlain(await handle(msg));
  assert.match(out, /Activated Jarvis across/);
  assert.match(out, /2 groups are now on/);
  assert.equal(createActivation(store).isActive('c@g.us'), true);
  assert.match(toPlain(await handle(msg)), /already active/); // idempotent
  store.close();
});

test('community: activation is not blocked when the community read is unavailable (transient failure)', async () => {
  const store = createStore({ path: ':memory:' });
  // info returns undefined (e.g. a transient metadata-fetch failure) - activation is a local write,
  // so it must still go through; the confirmation just falls back to the id instead of the name.
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', store, community: fakeCommunity(undefined) });
  const out = toPlain(await handle({ text: 'jarvis community activate c@g.us', sender: 'boss', level: 'private' }));
  assert.match(out, /Activated Jarvis across/);
  assert.equal(createActivation(store).isActive('c@g.us'), true);
  store.close();
});

test('community: the owner deactivates the community umbrella (by id, from a DM)', async () => {
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('c@g.us', 'boss');
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', store, community: fakeCommunity(INFO) });
  const out = toPlain(await handle({ text: 'jarvis community deactivate c@g.us', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Deactivated Jarvis across/);
  assert.equal(createActivation(store).isActive('c@g.us'), false);
});

test('community: activation is owner-only - an admin cannot', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', store, community: fakeCommunity(INFO) });
  const out = await handle({ text: 'jarvis community activate', sender: 'adm', level: 'community', chatId: 'c@g.us', community: 'c@g.us', isAdmin: true });
  assert.match(toPlain(out), /Only the owner can activate a community/);
  assert.equal(createActivation(store).isActive('c@g.us'), false);
  store.close();
});

test('community: the show view tags the activation state across the community', async () => {
  const store = createStore({ path: ':memory:' });
  createActivation(store).activate('c@g.us', 'boss'); // umbrella on
  const handle = createDispatcher(createRegistry([community]), { owner: 'boss', store, community: fakeCommunity(INFO) });
  const out = toPlain(await handle({ text: 'jarvis community', sender: 'boss', level: 'community', chatId: 'c@g.us', community: 'c@g.us' }));
  assert.match(out, /Community Anul 2 .*\(active\)/);
  assert.match(out, /General \(412\) \(on\)/);
  store.close();
});
