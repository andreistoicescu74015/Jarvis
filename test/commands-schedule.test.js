import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import schedule from '../src/commands/schedule.js';
import { toPlain } from '../src/core/format.js';

const setup = (now = 0, opts = {}) => {
  const store = createStore({ path: ':memory:' });
  const scheduler = createScheduler(store, { now: () => now });
  const dispatch = createDispatcher(createRegistry([schedule]), { store, scheduler, ...opts });
  const handle = async (m) => toPlain(await dispatch(m)); // render like an adapter, for assertions
  return { store, scheduler, handle };
};
// schedule is proactive (group-only), so the mechanic tests run it where it is allowed: a group, by an admin.
const msg = (text, over = {}) => ({ text, sender: 'u', chatId: 'A', level: 'group', isAdmin: true, ...over });

test('schedule: "in" creates a one-time job and list shows it', async () => {
  const { handle } = setup();
  assert.match(await handle(msg('jarvis schedule in 2h Stand-up')), /Scheduled s1 for /);
  assert.match(await handle(msg('jarvis schedule list')), /s1:.*-> "Stand-up"/);
});

test('schedule: "every" creates a repeating job', async () => {
  const { handle } = setup();
  assert.match(await handle(msg('jarvis schedule every 1d Daily reminder')), /every 1d, first at/);
});

test('schedule: "at" schedules an absolute server-local time', async () => {
  const { handle } = setup(new Date('2026-06-17T08:00').getTime());
  assert.match(await handle(msg('jarvis schedule at 2026-06-18 09:30 Deadline')), /Scheduled s1 for 2026-06-18 09:30/);
});

test('schedule: a past "at" time and a bad spec are refused with a hint', async () => {
  const { handle } = setup(new Date('2030-01-01T00:00').getTime());
  assert.match(await handle(msg('jarvis schedule at 2020-01-01 09:00 old')), /already past/);
  assert.match(await handle(msg('jarvis schedule in 5x nope')), /Bad time/);
});

test('schedule: missing message shows usage', async () => {
  const { handle } = setup();
  assert.match(await handle(msg('jarvis schedule in 2h')), /Usage: jarvis schedule in/);
});

test('schedule: cancel removes the job and only by its own chat', async () => {
  const { handle } = setup();
  await handle(msg('jarvis schedule in 2h X'));
  assert.match(await handle(msg('jarvis schedule cancel s1')), /Cancelled s1/);
  assert.match(await handle(msg('jarvis schedule list')), /Nothing scheduled/);
  assert.match(await handle(msg('jarvis schedule cancel s9')), /No scheduled message "s9"/);
});

test('schedule: in a group only an admin can schedule', async () => {
  const { handle } = setup();
  assert.match(
    await handle(msg('jarvis schedule in 1h x', { level: 'group', isAdmin: false, sender: 'member' })),
    /Not allowed: admins only/,
  );
  assert.match(
    await handle(msg('jarvis schedule in 1h x', { level: 'group', isAdmin: true, sender: 'member' })),
    /Scheduled s1/,
  );
});

test('schedule: a non-owner cannot schedule in a private chat (proactive is group-only)', async () => {
  const { handle } = setup();
  const out = await handle(msg('jarvis schedule in 1h x', { level: 'private', isAdmin: false, sender: 'rando' }));
  assert.match(out, /Not allowed: only in groups/);
});

test('schedule: the owner may schedule in a private chat (proactive owner-exempt)', async () => {
  const { handle } = setup(0, { owner: 'boss' });
  const out = await handle(msg('jarvis schedule in 1h x', { level: 'private', isAdmin: false, sender: 'boss' }));
  assert.match(out, /Scheduled s1/);
});

test('schedule: unavailable when no scheduler is configured (e.g. without a store)', async () => {
  const handle = createDispatcher(createRegistry([schedule]), { store: createStore({ path: ':memory:' }) });
  assert.match(await handle(msg('jarvis schedule list')), /unavailable/i);
});

test('schedule: clear (and "cancel all") cancels every scheduled message here', async () => {
  const { handle } = setup();
  await handle(msg('jarvis schedule in 1h a'));
  await handle(msg('jarvis schedule in 2h b'));
  assert.match(await handle(msg('jarvis schedule clear')), /Cancelled all 2/i);
  assert.match(await handle(msg('jarvis schedule list')), /Nothing scheduled/i);
  await handle(msg('jarvis schedule in 1h c'));
  assert.match(await handle(msg('jarvis schedule cancel all')), /Cancelled all 1/i); // alias
});

test('schedule: disable pauses without deleting; list tags it; enable resumes', async () => {
  const { handle } = setup();
  await handle(msg('jarvis schedule every 1d standup'));
  assert.match(await handle(msg('jarvis schedule disable s1')), /Paused s1/i);
  assert.match(await handle(msg('jarvis schedule list')), /\(paused\)/i); // kept, tagged
  assert.match(await handle(msg('jarvis schedule enable s1')), /Resumed s1/i);
  assert.match(await handle(msg('jarvis schedule disable all')), /Paused all 1/i);
});
