import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createScheduler, parseWhen, startScheduler } from '../src/core/scheduler.js';

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

test('parseWhen: in / every / at, and rejects junk + past', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  assert.deepEqual(parseWhen('in 2h', now), { ok: true, fireAt: now + 2 * H, repeatMs: 0 });
  assert.deepEqual(parseWhen('every 1d', now), { ok: true, fireAt: now + D, repeatMs: D });
  const at = parseWhen('at 2999-01-02 03:04', now);
  assert.equal(at.ok, true);
  assert.equal(at.repeatMs, 0);
  assert.equal(at.fireAt, new Date('2999-01-02T03:04').getTime()); // server-local

  assert.equal(parseWhen('in 0h', now).ok, false); // zero is not a duration
  assert.equal(parseWhen('in 2x', now).ok, false); // unknown unit
  assert.equal(parseWhen('nonsense', now).ok, false);
  assert.equal(parseWhen('at 1999-01-01 00:00', now).reason, 'past');
  assert.equal(parseWhen('at 2026-06-31 09:00', now).ok, false); // impossible date (June has 30 days)
  assert.equal(parseWhen('at 2026-02-30 09:00', now).ok, false); // rolls forward in JS -> rejected
});

test('scheduler: add returns an id; list is per-chat, soonest first', () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  const a = s.add({ chatId: 'A', when: 'in 2h', text: 'later' });
  const b = s.add({ chatId: 'A', when: 'in 1h', text: 'sooner' });
  s.add({ chatId: 'B', when: 'in 1h', text: 'other chat' });
  assert.equal(a.ok && b.ok, true);
  const list = s.list('A');
  assert.deepEqual(list.map((j) => j.id), [b.id, a.id]); // soonest first
  assert.deepEqual(list.map((j) => j.text), ['sooner', 'later']);
  assert.equal(s.list('B').length, 1); // bound per chat
});

test('scheduler: a one-time job fires once at its time, then is gone', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  s.add({ chatId: 'A', when: 'in 1h', text: 'ping' });
  const sent = [];
  const deliver = (chatId, text) => sent.push({ chatId, text });
  assert.deepEqual(await s.tick(deliver, 30 * M), { fired: 0, failed: 0 }); // not due yet
  assert.deepEqual(await s.tick(deliver, H), { fired: 1, failed: 0 }); // due
  assert.deepEqual(sent, [{ chatId: 'A', text: 'ping' }]);
  assert.deepEqual(await s.tick(deliver, 2 * H), { fired: 0, failed: 0 }); // gone
  assert.equal(s.list('A').length, 0);
});

test('scheduler: a repeating job reschedules to its next future slot (no storm for missed)', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  s.add({ chatId: 'A', when: 'every 1h', text: 'tick' }); // first at 1h
  const sent = [];
  const deliver = (_c, t) => sent.push(t);
  // Back online at 3.5h after being down: it fires once, not three times.
  assert.deepEqual(await s.tick(deliver, 3.5 * H), { fired: 1, failed: 0 });
  assert.equal(sent.length, 1);
  const [job] = s.list('A');
  assert.equal(job.fireAt, 4 * H); // next slot strictly after 3.5h
});

test('scheduler: schedules persist; a job missed while down fires on the next tick', async () => {
  let now = 0;
  const store = createStore({ path: ':memory:' });
  createScheduler(store, { now: () => now }).add({ chatId: 'A', when: 'in 1h', text: 'missed' });
  // "Restart": a fresh scheduler over the same store still sees the persisted job.
  const s2 = createScheduler(store, { now: () => now });
  const sent = [];
  assert.deepEqual(await s2.tick((_c, t) => sent.push(t), 5 * H), { fired: 1, failed: 0 });
  assert.deepEqual(sent, ['missed']);
});

test('scheduler: cancel is chat-scoped; a failed delivery still clears a one-time job', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  const a = s.add({ chatId: 'A', when: 'in 1h', text: 'x' });
  assert.equal(s.cancel('#seq', 'A').ok, false); // the internal id counter is not a cancellable job
  assert.equal(s.cancel(a.id, 'B').ok, false); // not B's job to cancel
  assert.equal(s.cancel(a.id, 'A').ok, true);
  assert.equal(s.list('A').length, 0);

  s.add({ chatId: 'A', when: 'in 1h', text: 'boom' });
  const res = await s.tick(() => {
    throw new Error('offline');
  }, 2 * H);
  assert.deepEqual(res, { fired: 0, failed: 1 }); // best-effort
  assert.equal(s.list('A').length, 0); // no retry storm
});

test('scheduler: a failing repeating job advances instead of re-firing forever', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  s.add({ chatId: 'A', when: 'every 1h', text: 'r' }); // first at 1h
  const boom = () => {
    throw new Error('offline');
  };
  assert.deepEqual(await s.tick(boom, H), { fired: 0, failed: 1 }); // delivery failed at 1h
  assert.equal(s.list('A')[0].fireAt, 2 * H); // advanced despite the failure - not stuck at 1h
  assert.deepEqual(await s.tick(boom, H), { fired: 0, failed: 0 }); // a re-tick at 1h does not re-fire
});

test('scheduler: a job cancelled during its own delivery is not resurrected', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  const a = s.add({ chatId: 'A', when: 'every 1h', text: 'r' }); // repeating -> would normally reschedule
  // deliver cancels the job mid-flight, as an inbound `schedule cancel` would (shared store).
  const deliver = () => s.cancel(a.id, 'A');
  assert.deepEqual(await s.tick(deliver, H), { fired: 1, failed: 0 });
  assert.equal(s.list('A').length, 0); // stays cancelled - not rescheduled back to life
});

test('startScheduler: ticks never overlap, and stop() awaits the in-flight tick', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  s.add({ chatId: 'A', when: 'in 1m', text: 'a' });
  now = 10 * 60_000; // make the job due (tick uses the injected now())

  let entered;
  const enteredP = new Promise((res) => (entered = res));
  let release;
  const releaseP = new Promise((res) => (release = res));
  let calls = 0;
  const deliver = async () => {
    calls++;
    entered();
    await releaseP; // hold the tick in-flight
  };

  const runner = startScheduler({ scheduler: s, deliver, intervalMs: 5 });
  await enteredP; // the first tick has entered deliver
  await new Promise((r) => setTimeout(r, 40)); // several more intervals fire while we block
  assert.equal(calls, 1); // the re-entrancy guard kept them from overlapping
  release();
  await runner.stop(); // resolves only after the in-flight tick completes
  assert.equal(s.list('A').length, 0); // the one-time job was delivered and cleared
});
