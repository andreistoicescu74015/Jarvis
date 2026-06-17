import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import groups from '../src/commands/groups.js';

test('groups: lists the known groups with ids, sorted by name', async () => {
  const listGroups = async () => [
    { id: '123-1@g.us', name: 'Study' },
    { id: '456-2@g.us', name: 'Friends' },
  ];
  const handle = createDispatcher(createRegistry([groups]), { owner: 'boss', listGroups });
  const out = await handle({ text: 'jarvis groups', sender: 'boss', level: 'private' });
  assert.match(out, /Groups \(2\):/);
  assert.match(out, /- Friends - 456-2@g\.us\n- Study - 123-1@g\.us/); // alphabetical
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
