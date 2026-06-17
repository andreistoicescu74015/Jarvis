import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import link from '../src/commands/link.js';
import note from '../src/commands/note.js';

const setup = () => createDispatcher(createRegistry([link, note]), { store: createStore({ path: ':memory:' }) });
const admin = (handle, text, chatId) => handle({ text, sender: 'u', chatId, level: 'group', isAdmin: true });
const codeFrom = (out) => out.match(/code: (\S+)/i)[1];

test('link cmd: propose in A, accept in B -> they share one context', async () => {
  const handle = setup();
  const code = codeFrom(await admin(handle, 'jarvis link new', 'A'));
  assert.match(await admin(handle, `jarvis link accept ${code}`, 'B'), /Linked/);
  await admin(handle, 'jarvis note add shared', 'A');
  assert.match(await admin(handle, 'jarvis note list', 'B'), /shared/); // B sees A's note
});

test('link cmd: status reflects the link, and remove leaves it', async () => {
  const handle = setup();
  assert.match(await admin(handle, 'jarvis link', 'A'), /Not linked/);
  const code = codeFrom(await admin(handle, 'jarvis link new', 'A'));
  await admin(handle, `jarvis link accept ${code}`, 'B');
  assert.match(await admin(handle, 'jarvis link', 'A'), /Linked with: B/);
  assert.match(await admin(handle, 'jarvis link remove', 'A'), /Unlinked/);
  assert.match(await admin(handle, 'jarvis link', 'A'), /Not linked/);
});

test('link cmd: a group needs an admin; a private user can link', async () => {
  const handle = setup();
  assert.match(
    await handle({ text: 'jarvis link new', sender: 'u', chatId: 'G', level: 'group', isAdmin: false }),
    /Not allowed: admins only/,
  );
  assert.match(await handle({ text: 'jarvis link new', sender: 'u', chatId: 'P', level: 'private' }), /Linking code/);
});

test('link cmd: a bad code is reported clearly', async () => {
  const handle = setup();
  assert.match(await admin(handle, 'jarvis link accept NOPE', 'B'), /Unknown code/);
});
