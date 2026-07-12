import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeliver } from '../src/whatsapp/deliver.js';

/**
 * A deliver wired to fakes: `active` ids pass the activation gate, `parents` maps a sub-group to its
 * community, `reply` is what the fake dispatcher returns for an AI job. Records sends, dispatcher
 * calls, and community lookups so tests can assert exactly what reached each seam.
 */
function setup({ active = [], parents = {}, requireActivation = true, reply = undefined, sendResult = true } = {}) {
  const sent = [];
  const handled = [];
  const lookups = [];
  const deliver = createDeliver({
    send: (chatId, message) => {
      sent.push({ chatId, message });
      return sendResult;
    },
    communityOf: async (chatId) => {
      lookups.push(chatId);
      return parents[chatId];
    },
    // The shared activation predicate (activation.isActiveVia in production).
    isActiveVia: (id, community) => active.includes(id) || (!!community && active.includes(community)),
    handle: async (msg) => {
      handled.push(msg);
      return reply;
    },
    requireActivation,
  });
  return { deliver, sent, handled, lookups };
}

test('deliver: declines a send to an inactive group, so the job stays pending', async () => {
  const { deliver, sent } = setup();
  assert.equal(await deliver('g@g.us', 'hi'), false); // DECLINE, not a failure
  assert.equal(sent.length, 0);
});

test('deliver: posts plain text to a directly-activated group', async () => {
  const { deliver, sent } = setup({ active: ['g@g.us'] });
  assert.equal(await deliver('g@g.us', 'hi'), true);
  assert.deepEqual(sent, [{ chatId: 'g@g.us', message: 'hi' }]);
});

test('deliver: the community umbrella opens the gate for a sub-group with no own entry', async () => {
  const { deliver, sent } = setup({ active: ['c@g.us'], parents: { 's@g.us': 'c@g.us' } });
  assert.equal(await deliver('s@g.us', 'hi'), true);
  assert.equal(sent.length, 1);
});

test('deliver: an AI job in an umbrella-activated sub-group reaches the dispatcher WITH its community', async () => {
  // Regression: without `community` on the synthetic message, the dispatcher's own activation gate
  // re-runs blind, silently swallows the job, and a one-shot is consumed without ever posting.
  const { deliver, sent, handled } = setup({
    active: ['c@g.us'],
    parents: { 's@g.us': 'c@g.us' },
    reply: 'weekly summary',
  });
  assert.equal(await deliver('s@g.us', 'summarize the week', { kind: 'ai', createdBy: 'boss' }), true);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].community, 'c@g.us'); // the load-bearing fact
  assert.equal(handled[0].chatId, 's@g.us');
  assert.equal(handled[0].sender, 'boss'); // runs as the owner who scheduled it
  // Community chats live-classify as level 'community' (identity.js levelOf), and the dispatcher
  // keys the chat's own data namespace on the level - 'group' here would read/write group:<id>
  // while live use of the same chat reads community:<id>.
  assert.equal(handled[0].level, 'community');
  assert.equal(handled[0].addressed, true);
  assert.equal(handled[0].scheduled, true);
  assert.deepEqual(sent, [{ chatId: 's@g.us', message: 'weekly summary' }]); // and the result is posted
});

test('deliver: a plain (non-community) group AI job still runs at level group', async () => {
  const { deliver, handled } = setup({ active: ['g@g.us'], reply: 'ok' });
  await deliver('g@g.us', 'list notes', { kind: 'ai', createdBy: 'boss' });
  assert.equal(handled[0].level, 'group');
  assert.equal(handled[0].community, undefined);
});

test('deliver: an AI job the dispatcher DECLINES (false = AI unavailable) stays pending', async () => {
  // Regression: with the daily token cap spent (or the provider throttled/down), the instruction
  // never ran - deliver must decline so the scheduler retries later, not consume the one-shot.
  const { deliver, sent, handled } = setup({ active: ['g@g.us'], reply: false });
  assert.equal(await deliver('g@g.us', 'summarize the notes', { kind: 'ai', createdBy: 'boss' }), false);
  assert.equal(handled.length, 1); // the dispatcher was consulted...
  assert.equal(sent.length, 0); // ...but nothing went out, and the job is NOT advanced
});

test('deliver: an AI job that produces nothing still advances (fires without sending)', async () => {
  const { deliver, sent, handled } = setup({ active: ['g@g.us'], reply: undefined });
  assert.equal(await deliver('g@g.us', 'do something vague', { kind: 'ai', createdBy: 'boss' }), true);
  assert.equal(handled.length, 1); // the dispatcher ran...
  assert.equal(sent.length, 0); // ...but there was nothing to post, and the job is not retried
});

test('deliver: an AI job in a private chat runs ungated, with no community lookup', async () => {
  const { deliver, sent, handled, lookups } = setup({ reply: 'done' });
  assert.equal(await deliver('u@s.whatsapp.net', 'list my notes', { kind: 'ai', createdBy: 'boss' }), true);
  assert.equal(lookups.length, 0); // a DM has no community to resolve
  assert.equal(handled[0].level, 'private');
  assert.equal(handled[0].community, undefined);
  assert.equal(sent.length, 1);
});

test('deliver: with activation not required, an inactive group still receives the send', async () => {
  const { deliver, sent } = setup({ requireActivation: false });
  assert.equal(await deliver('g@g.us', 'hi'), true);
  assert.equal(sent.length, 1);
});

test('deliver: a failed send propagates (false), so the scheduler leaves the job pending', async () => {
  const { deliver } = setup({ active: ['g@g.us'], sendResult: false });
  assert.equal(await deliver('g@g.us', 'hi'), false);
});

test('deliver: a two-argument call (no job) is a plain send', async () => {
  const { deliver, sent, handled } = setup({ active: ['g@g.us'] });
  await deliver('g@g.us', 'plain text');
  assert.equal(sent.length, 1);
  assert.equal(handled.length, 0); // never routed through the dispatcher
});
