import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createScheduler, parseWhen, parseNatural } from '../src/core/scheduler.js';

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

test('scheduler: add rejects an over-long message and an over-full chat (bounded storage)', () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  const long = s.add({ chatId: 'A', when: 'in 1h', text: 'x'.repeat(1001) });
  assert.equal(long.ok, false);
  assert.equal(long.reason, 'too-long');
  for (let n = 0; n < 100; n++) assert.equal(s.add({ chatId: 'B', when: 'in 1h', text: `m${n}` }).ok, true);
  const overflow = s.add({ chatId: 'B', when: 'in 1h', text: 'one too many' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'too-many');
  assert.equal(s.list('B').length, 100); // capped, not 101
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

test('scheduler: every due job fires in one tick (pacing is downstream, not here)', async () => {
  let now = 0;
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  s.add({ chatId: 'A', when: 'in 1h', text: '1' });
  s.add({ chatId: 'A', when: 'in 1h', text: '2' }); // both due at 1h
  const sent = [];
  // No budget gating anymore: both due jobs go out; the platform's send limiter spaces them.
  assert.deepEqual(await s.tick((_c, t) => sent.push(t), H), { fired: 2, failed: 0 });
  assert.deepEqual(sent, ['1', '2']); // both delivered, none deferred
  assert.equal(s.list('A').length, 0);
});

test('scheduler: a declined delivery (deliver returns false) leaves the job pending - not fired, not advanced', async () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  s.add({ chatId: 'A', when: 'every 1h', text: 'r' }); // repeating, first at 1h
  // The destination is currently ineligible (e.g. an inactive group): deliver declines.
  assert.deepEqual(await s.tick(() => false, H), { fired: 0, failed: 0 }); // neither fired nor failed
  assert.equal(s.list('A')[0].fireAt, H); // still due at 1h - NOT advanced
  // Eligible again: it fires once and advances normally.
  const sent = [];
  assert.deepEqual(await s.tick((_c, t) => sent.push(t), H), { fired: 1, failed: 0 });
  assert.deepEqual(sent, ['r']);
  assert.equal(s.list('A')[0].fireAt, 2 * H);
});

test('scheduler: a declined one-time job is left pending, not silently dropped', async () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  s.add({ chatId: 'A', when: 'in 1h', text: 'once' });
  await s.tick(() => false, H);
  assert.equal(s.list('A').length, 1); // still there, will deliver when eligible again
});

test('scheduler: clearChat removes only that chat\'s jobs (e.g. the bot was removed from a group)', () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  s.add({ chatId: 'A', when: 'in 1h', text: 'a1' });
  s.add({ chatId: 'A', when: 'in 2h', text: 'a2' });
  s.add({ chatId: 'B', when: 'in 1h', text: 'b1' });
  assert.equal(s.clearChat('A'), 2);
  assert.equal(s.list('A').length, 0);
  assert.equal(s.list('B').length, 1); // untouched
});

test('scheduler: add reports empty text distinctly from a bad time', () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  assert.deepEqual(s.add({ chatId: 'A', when: 'in 1h', text: '   ' }), { ok: false, reason: 'empty-text' });
  assert.equal(s.add({ chatId: 'A', when: 'nonsense', text: 'hi' }).reason, 'bad-when');
});

test('scheduler: a disabled job is kept but skipped by tick; enabling resumes it', async () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  const a = s.add({ chatId: 'A', when: 'in 1h', text: 'x' });
  assert.equal(s.setEnabled(a.id, 'A', false).ok, true); // pause
  const sent = [];
  assert.deepEqual(await s.tick((_c, t) => sent.push(t), H), { fired: 0, failed: 0 }); // skipped while paused
  assert.equal(s.list('A')[0].disabled, true); // still there, marked paused
  s.setEnabled(a.id, 'A', true); // resume
  assert.deepEqual(await s.tick((_c, t) => sent.push(t), H), { fired: 1, failed: 0 });
  assert.deepEqual(sent, ['x']);
});

test('scheduler: setEnabledAll pauses/resumes a whole chat; another chat is untouched', () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  s.add({ chatId: 'A', when: 'in 1h', text: '1' });
  s.add({ chatId: 'A', when: 'in 2h', text: '2' });
  s.add({ chatId: 'B', when: 'in 1h', text: 'b' });
  assert.equal(s.setEnabledAll('A', false), 2);
  assert.ok(s.list('A').every((j) => j.disabled));
  assert.ok(s.list('B').every((j) => !j.disabled)); // B untouched
  assert.equal(s.setEnabled('nope', 'A', true).ok, false); // unknown id
});

test('scheduler: an ai job stores its kind and tick hands the whole job to deliver', async () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  const r = s.add({ chatId: 'A', createdBy: 'boss', when: 'in 1h', text: 'do a thing', kind: 'ai' });
  assert.ok(r.ok);
  assert.equal(s.list('A')[0].kind, 'ai'); // stored
  const got = [];
  await s.tick((chatId, text, job) => { got.push({ chatId, text, kind: job?.kind, by: job?.createdBy }); return true; }, H);
  assert.deepEqual(got, [{ chatId: 'A', text: 'do a thing', kind: 'ai', by: 'boss' }]);
});

test('scheduler: a plain job carries no kind (shape unchanged)', () => {
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => 0 });
  s.add({ chatId: 'A', when: 'in 1h', text: 'hi' });
  assert.ok(!('kind' in s.list('A')[0])); // no kind key on a normal job
});

test('parseNatural: extracts a relative time and leaves the rest as the message', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  assert.deepEqual(parseNatural('call mom in 2 hours', now), { ok: true, fireAt: now + 2 * H, message: 'call mom' });
});

test('parseNatural: an absolute "tomorrow at 9am" resolves forward to 09:00 the next day', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  const r = parseNatural('dentist tomorrow at 9am', now);
  assert.equal(r.ok, true);
  assert.equal(r.message, 'dentist');
  const d = new Date(r.fireAt);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 18); // the day after the 17th
});

test('parseNatural: distinct reasons for recurrence, no-time, past, and a time-only (empty) message', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  assert.equal(parseNatural('every monday standup', now).reason, 'no-nl-recurrence'); // refused before chrono
  assert.equal(parseNatural('just buy milk', now).reason, 'no-time'); // no time in the text
  assert.equal(parseNatural('recap on 2020-01-01 09:00', now).reason, 'past'); // explicit past date
  assert.equal(parseNatural('tomorrow at 9am', now).reason, 'empty-text'); // a time but nothing left to say
});

test('scheduler: addNatural parses free text, stores the message, one-shot', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  const r = s.addNatural({ chatId: 'A', input: 'call mom in 2 hours' });
  assert.equal(r.ok, true);
  assert.equal(r.repeatMs, 0); // recurrence is not inferred from natural language
  const [job] = s.list('A');
  assert.equal(job.text, 'call mom');
  assert.equal(job.fireAt, now + 2 * H);
});

test('scheduler: addNatural refuses recurrence words and a line with no time', () => {
  const now = new Date('2026-06-17T12:00').getTime();
  const s = createScheduler(createStore({ path: ':memory:' }), { now: () => now });
  assert.equal(s.addNatural({ chatId: 'A', input: 'weekly review' }).reason, 'no-nl-recurrence');
  assert.equal(s.addNatural({ chatId: 'A', input: 'no time here' }).reason, 'no-time');
  assert.equal(s.list('A').length, 0); // nothing stored on a rejection
});
