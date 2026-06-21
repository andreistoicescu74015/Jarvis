import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient } from '../src/core/ai.js';

const tools = [{ type: 'function', function: { name: 'whitelist', parameters: {} } }];

/** A fetch stub returning a canned chat-completions response; optionally records the request. */
function fakeFetch(response, { ok = true, status = 200, capture } = {}) {
  return async (url, init) => {
    if (capture) { capture.url = url; capture.init = init; }
    return { ok, status, json: async () => response };
  };
}

const toolCall = (name, args) => ({
  choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
});

test('ai: no token -> client is null (AI simply off)', () => {
  assert.equal(createAiClient({ token: '' }), null);
  assert.equal(createAiClient({}), null);
});

test('ai: translate returns the tool call as { command, args } and sends a well-formed request', async () => {
  const capture = {};
  const ai = createAiClient({
    token: 't', model: 'm',
    fetchImpl: fakeFetch(toolCall('whitelist', { target: '*', verb: 'enable' }), { capture }),
  });
  const out = await ai.translate({ text: 'open up to everyone', tools });
  assert.deepEqual(out, { command: 'whitelist', args: { target: '*', verb: 'enable' } });
  assert.match(capture.url, /\/chat\/completions$/);
  assert.equal(capture.init.headers.authorization, 'Bearer t');
  const body = JSON.parse(capture.init.body);
  assert.equal(body.model, 'm');
  assert.equal(body.tools.length, 1);
  assert.equal(body.messages.at(-1).content, 'open up to everyone');
});

test('ai: no tool call -> null (no command matched)', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({ choices: [{ message: { content: 'hi' } }] }) });
  assert.equal(await ai.translate({ text: 'how are you?', tools }), null);
});

test('ai: a non-ok response -> null (best-effort, never throws)', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({}, { ok: false, status: 429 }) });
  assert.equal(await ai.translate({ text: 'x', tools }), null);
});

test('ai: a fetch error -> null', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(await ai.translate({ text: 'x', tools }), null);
});

test('ai: empty text or empty tools -> null without calling out', async () => {
  let called = false;
  const ai = createAiClient({ token: 't', fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  assert.equal(await ai.translate({ text: '', tools }), null);
  assert.equal(await ai.translate({ text: 'x', tools: [] }), null);
  assert.equal(called, false);
});

test('ai: malformed tool arguments degrade to empty args, not a throw', async () => {
  const ai = createAiClient({
    token: 't',
    fetchImpl: fakeFetch({ choices: [{ message: { tool_calls: [{ function: { name: 'ping', arguments: '{bad json' } }] } }] }),
  });
  assert.deepEqual(await ai.translate({ text: 'x', tools }), { command: 'ping', args: {} });
});
