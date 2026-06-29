import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createActivation } from '../src/core/activation.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import link from '../src/commands/link.js';
import note from '../src/commands/note.js';
import { toPlain } from '../src/core/format.js';

/** A dispatcher with link+note; groups gA/gB are pre-activated so they are allowed to link. */
function setup() {
  const store = createStore({ path: ':memory:' });
  const activation = createActivation(store);
  activation.activate('gA', 'boss');
  activation.activate('gB', 'boss');
  const handle = createDispatcher(createRegistry([link, note]), { store });
  return { store, handle };
}
const admin = (handle, text, chatId) => handle({ text, sender: 'u', chatId, level: 'group', isAdmin: true });
const codeFrom = (out) => toPlain(out).match(/code: (\S+)/i)[1];

test('link cmd: refused (and hidden) in a private chat - it is group-only', async () => {
  const { handle } = setup();
  const out = toPlain(await handle({ text: 'jarvis link new', sender: 'u', chatId: 'dm', level: 'private' }));
  assert.match(out, /only in groups/i); // group-only scope refuses a non-owner DM (and hides it from help/catalog)
});

test('link cmd: linking needs a group admin', async () => {
  const { handle } = setup();
  assert.match(
    await handle({ text: 'jarvis link new', sender: 'u', chatId: 'gA', level: 'group', isAdmin: false }),
    /Not allowed: admins only/,
  );
});

test('link cmd: propose in one group, accept in another, share data, then remove', async () => {
  const { handle } = setup();
  assert.match(await admin(handle, 'jarvis link', 'gA'), /Not linked/);
  const code = codeFrom(await admin(handle, 'jarvis link new', 'gA'));
  assert.match(await admin(handle, `jarvis link accept ${code}`, 'gB'), /Linked/);
  // the two groups now share one data context
  await admin(handle, 'jarvis note add shared', 'gA');
  assert.match(await admin(handle, 'jarvis note list', 'gB'), /shared/); // gB sees gA's note
  // status + remove
  assert.match(toPlain(await admin(handle, 'jarvis link', 'gA')), /Linked with: gB/);
  assert.match(await admin(handle, 'jarvis link remove', 'gA'), /Unlinked/);
  assert.match(await admin(handle, 'jarvis link', 'gA'), /Not linked/);
});

test('link cmd: a bad code is reported clearly', async () => {
  const { handle } = setup();
  assert.match(await admin(handle, 'jarvis link accept NOPE', 'gB'), /Unknown code/);
});

test('link cmd: cannot link into a group that is not active', async () => {
  const { handle } = setup();
  const code = codeFrom(await admin(handle, 'jarvis link new', 'gA'));
  // gC was never activated -> accept refuses
  assert.match(await admin(handle, `jarvis link accept ${code}`, 'gC'), /must be active/i);
});
