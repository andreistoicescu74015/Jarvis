import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient, buildChatSystem } from '../src/core/ai.js';

const tools = [{ type: 'function', function: { name: 'whitelist', parameters: {} } }];
const EMPTY = { commands: [], answer: null };

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

const multiCall = (...pairs) => ({
  choices: [{ message: { tool_calls: pairs.map(([name, args]) => ({ function: { name, arguments: JSON.stringify(args) } })) } }],
});

test('ai: no token -> client is null (AI simply off)', () => {
  assert.equal(createAiClient({ token: '' }), null);
  assert.equal(createAiClient({}), null);
});

test('ai: translate returns the tool call as commands and sends a well-formed request', async () => {
  const capture = {};
  const ai = createAiClient({
    token: 't', model: 'm',
    fetchImpl: fakeFetch(toolCall('whitelist', { target: '*', verb: 'enable' }), { capture }),
  });
  const out = await ai.translate({ text: 'open up to everyone', tools });
  assert.deepEqual(out, { commands: [{ command: 'whitelist', args: { target: '*', verb: 'enable' } }], answer: null });
  assert.match(capture.url, /\/chat\/completions$/);
  assert.equal(capture.init.headers.authorization, 'Bearer t');
  const body = JSON.parse(capture.init.body);
  assert.equal(body.model, 'm');
  assert.equal(body.temperature, 0); // deterministic translation
  assert.equal(body.tool_choice, 'auto'); // model may map to a tool, decline, or (in chat) answer
  assert.equal(body.tools.length, 1);
  assert.equal(body.messages.at(-1).content, 'open up to everyone');
});

test('ai: no tool call (not in chat mode) -> no commands and no answer', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({ choices: [{ message: { content: 'hi' } }] }) });
  assert.deepEqual(await ai.translate({ text: 'how are you?', tools }), EMPTY);
});

test('ai: chat mode returns the model text as the answer when no tool is called', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({ choices: [{ message: { content: 'A lemon is small.' } }] }) });
  assert.deepEqual(await ai.translate({ text: 'how big is a lemon', tools, chat: true }), { commands: [], answer: 'A lemon is small.' });
  // the same response, NOT in chat mode, yields no answer (translation-only)
  assert.deepEqual(await ai.translate({ text: 'how big is a lemon', tools }), EMPTY);
});

test('ai: chat mode still prefers a tool call when the request maps to a command', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch(toolCall('whitelist', { target: '*', verb: 'enable' })) });
  assert.deepEqual(await ai.translate({ text: 'open up to everyone', tools, chat: true }), {
    commands: [{ command: 'whitelist', args: { target: '*', verb: 'enable' } }],
    answer: null,
  });
});

test('ai: a non-ok response -> empty (best-effort, never throws)', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({}, { ok: false, status: 500 }) });
  assert.deepEqual(await ai.translate({ text: 'x', tools }), EMPTY);
});

test('ai: a 429 stays empty but carries the provider throttle details from the headers', async () => {
  const headers = { get: (k) => ({ 'x-ratelimit-type': 'UserByModelByDay', 'retry-after': '120' })[k] };
  const ai = createAiClient({ token: 't', fetchImpl: async () => ({ ok: false, status: 429, headers, json: async () => ({}) }) });
  const out = await ai.translate({ text: 'x', tools });
  assert.deepEqual(out.commands, []);
  assert.equal(out.answer, null);
  assert.deepEqual(out.limit, { type: 'UserByModelByDay', retryAfterSec: 120 }); // what `jarvis ai` will surface
});

test('ai: a 429 with no rate-limit headers still resolves empty, with a bare limit marker', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch({}, { ok: false, status: 429 }) });
  const out = await ai.translate({ text: 'x', tools });
  assert.deepEqual(out.commands, []);
  assert.deepEqual(out.limit, { type: '', retryAfterSec: 0 });
});

test('ai: a fetch error -> empty', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: async () => { throw new Error('network down'); } });
  assert.deepEqual(await ai.translate({ text: 'x', tools }), EMPTY);
});

test('ai: empty text or empty tools -> empty without calling out', async () => {
  let called = false;
  const ai = createAiClient({ token: 't', fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  assert.deepEqual(await ai.translate({ text: '', tools }), EMPTY);
  assert.deepEqual(await ai.translate({ text: 'x', tools: [] }), EMPTY);
  assert.equal(called, false);
});

test('ai: malformed tool arguments degrade to empty args, not a throw', async () => {
  const ai = createAiClient({
    token: 't',
    fetchImpl: fakeFetch({ choices: [{ message: { tool_calls: [{ function: { name: 'ping', arguments: '{bad json' } }] } }] }),
  });
  assert.deepEqual(await ai.translate({ text: 'x', tools }), { commands: [{ command: 'ping', args: {} }], answer: null });
});

test('ai: multiple tool calls become an ordered chain', async () => {
  const ai = createAiClient({
    token: 't',
    fetchImpl: fakeFetch(multiCall(
      ['blacklist', { target: 'note', verb: 'add', person: '*' }],
      ['blacklist', { target: 'note', verb: 'enable' }],
    )),
  });
  assert.deepEqual(await ai.translate({ text: 'block everyone from notes then enable it', tools }), {
    commands: [
      { command: 'blacklist', args: { target: 'note', verb: 'add', person: '*' } },
      { command: 'blacklist', args: { target: 'note', verb: 'enable' } },
    ],
    answer: null,
  });
});

test('ai: translate surfaces the provider token usage when the response reports it', async () => {
  const withTokens = {
    choices: [{ message: { tool_calls: [{ function: { name: 'ping', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  };
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch(withTokens) });
  assert.deepEqual(await ai.translate({ text: 'ping please', tools }), {
    commands: [{ command: 'ping', args: {} }],
    answer: null,
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  });
});

test('ai: a response without usage omits the key (unchanged shape for callers that ignore it)', async () => {
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch(toolCall('ping', {})) });
  assert.deepEqual(await ai.translate({ text: 'ping', tools }), { commands: [{ command: 'ping', args: {} }], answer: null });
});

test('ai: buildChatSystem keeps the functional rules and lets a persona replace only the voice', () => {
  const def = buildChatSystem();
  assert.match(def, /^You are Jarvis, a helpful WhatsApp assistant\./);
  assert.match(def, /Use ONLY the tools offered for commands/); // functional rules retained
  const custom = buildChatSystem('You are Jarvis. Be terse and formal. Reply in Romanian.');
  assert.match(custom, /^You are Jarvis\. Be terse and formal\. Reply in Romanian\./);
  assert.match(custom, /Use ONLY the tools offered for commands/); // same rules still appended
  assert.doesNotMatch(custom, /a helpful WhatsApp assistant/); // default voice replaced
  assert.equal(buildChatSystem('   '), def); // a blank persona falls back to the default voice
});

test('ai: a custom chatSystem is sent as the system prompt in chat mode', async () => {
  const capture = {};
  const ai = createAiClient({
    token: 't', chatSystem: 'CUSTOM VOICE\nrules...',
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'hi' } }] }, { capture }),
  });
  await ai.translate({ text: 'hello', tools, chat: true });
  assert.equal(JSON.parse(capture.init.body).messages[0].content, 'CUSTOM VOICE\nrules...');
});

test('ai: every request bounds the completion size (max_tokens), with an overridable default', async () => {
  const capture = {};
  const ai = createAiClient({ token: 't', fetchImpl: fakeFetch(toolCall('whitelist', {}), { capture }) });
  await ai.translate({ text: 'x', tools });
  assert.equal(JSON.parse(capture.init.body).max_tokens, 800); // the cost-discipline default
  const tight = {};
  const ai2 = createAiClient({ token: 't', maxTokens: 200, fetchImpl: fakeFetch(toolCall('whitelist', {}), { capture: tight }) });
  await ai2.translate({ text: 'x', tools });
  assert.equal(JSON.parse(tight.init.body).max_tokens, 200);
});
