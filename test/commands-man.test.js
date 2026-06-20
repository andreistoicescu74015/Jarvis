import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import man from '../src/commands/man.js';
import ping from '../src/commands/ping.js';
import shutdown from '../src/commands/shutdown.js';
import whitelist from '../src/commands/whitelist.js';
import schedule from '../src/commands/schedule.js';
import { toPlain } from '../src/core/format.js';

const dispatch = createDispatcher(createRegistry([man, ping, shutdown, whitelist, schedule]));
const handle = async (msg) => toPlain(await dispatch(msg)); // render like an adapter, for assertions

test('man: shows a command summary, usage, and audience', async () => {
  const out = await handle({ text: 'jarvis man ping', sender: 'x' });
  assert.match(out, /^ping - /m);
  assert.match(out, /Who: anyone/);
});

test('man: reports an owner-only audience from scope', async () => {
  const out = await handle({ text: 'jarvis man shutdown', sender: 'x' });
  assert.match(out, /Who: the owner only/);
});

test('man: includes the long-form man text when present', async () => {
  const out = await handle({ text: 'jarvis man whitelist', sender: 'x' });
  assert.match(out, /whole bot/i); // from the whitelist man text
});

test('man: reports the owner-or-admin audience for a management command', async () => {
  const out = await handle({ text: 'jarvis man whitelist', sender: 'x' });
  assert.match(out, /Who: the owner, or a group admin in their own chat/);
});

test('man: reports a group-only audience for a proactive command', async () => {
  const out = await handle({ text: 'jarvis man schedule', sender: 'x' });
  assert.match(out, /Who: group admins; groups only/);
});

test('man: documents itself (man is help-adjacent, available to anyone)', async () => {
  const out = await handle({ text: 'jarvis man man', sender: 'x' });
  assert.match(out, /man - Show detailed help/);
});

test('man: unknown command and the no-argument usage hint', async () => {
  assert.match(await handle({ text: 'jarvis man nope', sender: 'x' }), /No such command: nope/);
  assert.match(await handle({ text: 'jarvis man', sender: 'x' }), /Usage: jarvis man/);
});
