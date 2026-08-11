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

test('schedule ai: the owner schedules an AI instruction, stored as an ai job', async () => {
  const { scheduler, handle } = setup(0, { owner: 'boss' });
  const out = await handle({ text: 'jarvis schedule ai every 1d list the schedule', sender: 'boss', chatId: 'A', level: 'group' });
  assert.match(out, /Scheduled s1/);
  const job = scheduler.list('A')[0];
  assert.equal(job.kind, 'ai');
  assert.equal(job.text, 'list the schedule');
  assert.ok(job.repeatMs > 0); // "every 1d" repeats
});

test('schedule ai: a non-owner admin cannot schedule an AI action', async () => {
  const { handle } = setup(); // no owner; the default msg is a group admin
  assert.match(await handle(msg('jarvis schedule ai every 1d do stuff')), /Only the owner/i);
});

test('schedule ai: "at" schedules an AI instruction at an absolute time (owner)', async () => {
  const { scheduler, handle } = setup(new Date('2026-06-17T08:00').getTime(), { owner: 'boss' });
  const out = await handle({ text: 'jarvis schedule ai at 2026-06-18 09:00 post the agenda', sender: 'boss', chatId: 'A', level: 'group' });
  assert.match(out, /Scheduled s1 for 2026-06-18 09:00/);
  assert.equal(scheduler.list('A')[0].kind, 'ai');
});

test('schedule ai: a missing instruction or bad when-spec shows usage', async () => {
  const { handle } = setup(0, { owner: 'boss' });
  const m = (text) => ({ text, sender: 'boss', chatId: 'A', level: 'group' });
  assert.match(await handle(m('jarvis schedule ai every 1d')), /Usage:.*schedule ai every/i); // no instruction
  assert.match(await handle(m('jarvis schedule ai bogus stuff')), /Usage:.*schedule ai in/i); // bad when-spec
});

test('schedule: plain language schedules and list shows the extracted message', async () => {
  const { handle } = setup(new Date('2026-06-17T08:00').getTime());
  assert.match(await handle(msg('jarvis schedule call mom tomorrow at 9am')), /Scheduled s1 for 2026-06-18 09:00/);
  assert.match(await handle(msg('jarvis schedule list')), /s1:.*-> "call mom"/);
});

test('schedule: plain language with no time is refused with a hint', async () => {
  const { handle } = setup();
  assert.match(await handle(msg('jarvis schedule buy some milk')), /couldn't find a date or time/i);
});

test('schedule: plain-language recurrence points back to "every"', async () => {
  const { handle } = setup();
  assert.match(await handle(msg('jarvis schedule daily standup')), /every <N>/i);
});

test('schedule: "list all" shows the owner every chat\'s pending jobs, grouped and named', async () => {
  const { scheduler, handle } = setup(0, {
    owner: 'boss',
    listGroups: async () => [{ id: 'A', name: 'Study Group' }],
  });
  scheduler.add({ chatId: 'A', when: 'in 1h', text: 'stand up' });
  scheduler.add({ chatId: 'B', when: 'in 2h', text: 'other room' });
  scheduler.add({ chatId: 'A', when: 'in 3h', text: 'summarize', kind: 'ai' });
  const out = await handle(msg('jarvis schedule list all', { sender: 'boss' }));
  assert.match(out, /Scheduled everywhere \(3 in 2 chats\)/);
  assert.match(out, /Study Group A:/); // named from the platform's group list
  assert.match(out, /^B:$/m); // a chat that list cannot name still shows by id
  assert.match(out, /-> "other room"/); // another chat's job is visible from here - the point of the view
  assert.match(out, /\[ai\] -> "summarize"/); // an AI instruction is marked as one
});

test('schedule: "list all" is owner-only; a group admin sees only their own chat', async () => {
  const { scheduler, handle } = setup(0, { owner: 'boss' });
  scheduler.add({ chatId: 'A', when: 'in 1h', text: 'mine' });
  scheduler.add({ chatId: 'B', when: 'in 1h', text: 'theirs' });
  assert.match(await handle(msg('jarvis schedule list all')), /Only the owner/i); // sender 'u' is an admin, not the owner
  const own = await handle(msg('jarvis schedule list'));
  assert.match(own, /-> "mine"/);
  assert.doesNotMatch(own, /theirs/); // the per-chat view never leaks another chat's jobs
});

test('schedule: "list all" says so plainly when nothing is scheduled anywhere', async () => {
  const { handle } = setup(0, { owner: 'boss' });
  assert.match(await handle(msg('jarvis schedule list all', { sender: 'boss' })), /Nothing scheduled anywhere/);
});

test('schedule: "list all" survives a platform that cannot list groups (ids still answer)', async () => {
  const { scheduler, handle } = setup(0, {
    owner: 'boss',
    listGroups: async () => { throw new Error('socket down'); },
  });
  scheduler.add({ chatId: 'A', when: 'in 1h', text: 'stand up' });
  const out = await handle(msg('jarvis schedule list all', { sender: 'boss' }));
  assert.match(out, /Scheduled everywhere \(1 in 1 chat\)/);
  assert.match(out, /-> "stand up"/);
});

test('schedule: a bare "all" is still a natural-language reminder, not the global view', async () => {
  // "schedule all hands meeting tomorrow at 9am" must schedule, not list - which is why the global
  // view lives under the explicit `list` verb.
  const { handle } = setup(new Date('2026-06-17T08:00').getTime(), { owner: 'boss' });
  const out = await handle(msg('jarvis schedule all hands meeting tomorrow at 9am', { sender: 'boss' }));
  assert.match(out, /Scheduled s1 for 2026-06-18 09:00/);
  assert.doesNotMatch(out, /Scheduled everywhere/);
});
