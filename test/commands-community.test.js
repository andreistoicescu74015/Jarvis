import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
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
