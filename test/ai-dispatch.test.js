import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import { createStore } from '../src/store/index.js';
import { toPlain } from '../src/core/format.js';
import whitelist from '../src/commands/whitelist.js';
import blacklist from '../src/commands/blacklist.js';
import note from '../src/commands/note.js';
import groups from '../src/commands/groups.js';
import schedule from '../src/commands/schedule.js';
import reset from '../src/commands/reset.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

/** A fake AI client that records its calls and returns a canned proposal (or a function of the input). */
function fakeAi(proposal) {
  const calls = [];
  return {
    calls,
    translate: async ({ text, tools }) => {
      calls.push({ text, tools });
      const p = typeof proposal === 'function' ? proposal(text, tools) : proposal;
      if (p == null) return null;
      return Array.isArray(p) ? p : [p]; // accept a single proposal or a chain
    },
  };
}

test('ai dispatch: the owner\'s natural language is translated, run, and echoed as the command', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'whitelist', args: { target: '*', verb: 'enable' } });
  const handle = createDispatcher(createRegistry([ping, whitelist]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis activeaza whitelist pt toata lumea', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Understood: jarvis whitelist \* enable/); // echoes the canonical command
  assert.match(out, /Turned on the whitelist/); // and the command actually ran
  assert.equal(ai.calls[0].text, 'activeaza whitelist pt toata lumea'); // the model saw the full request (prefix stripped)
  store.close();
});

test('ai dispatch: a valid command never consults the AI (deterministic-first)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'whitelist', args: {} });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis ping', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.equal(out, 'pong'); // ran deterministically
  assert.equal(ai.calls.length, 0); // AI was never called for a known command
  store.close();
});

test('ai dispatch: a non-owner does not get AI (owner-only for now)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  // a group (no private lockdown), unknown first word, non-owner sender
  const out = toPlain(await handle({ text: 'jarvis salut', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Unknown command/); // fell back to deterministic behaviour
  assert.equal(ai.calls.length, 0); // AI never consulted for a non-owner
  store.close();
});

test('ai dispatch: when the model declines, it falls back to the unknown-command reply', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi(null); // no command matched
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis qwerty zxcv', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Unknown command/);
  assert.equal(ai.calls.length, 1); // the owner did consult AI, which declined
  store.close();
});

test('ai dispatch: an incomplete translation (missing a required arg) falls back, never half-runs', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'schedule', args: {} }); // schedule.action is required
  const handle = createDispatcher(createRegistry([ping, schedule]), { owner: 'boss', store, scheduler: { list: () => [], add: () => ({}), cancel: () => ({}) }, ai });
  const out = toPlain(await handle({ text: 'jarvis programeaza ceva', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Unknown command/); // the incomplete tool call is rejected
  store.close();
});

test('ai dispatch: the owner can drive an owner-only command in natural language', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'groups', args: { action: 'activate' } });
  const handle = createDispatcher(createRegistry([ping, groups]), {
    owner: 'boss', store, ai, listGroups: async () => [{ id: 'g@g.us', name: 'G' }],
  });
  const out = toPlain(await handle({ text: 'jarvis porneste-te aici', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis groups activate/);
  assert.match(out, /Activated Jarvis in/);
  store.close();
});

test('ai dispatch: the tool catalog is scope-filtered (the owner sees owner-only tools)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} });
  const handle = createDispatcher(createRegistry([ping, groups, whitelist]), { owner: 'boss', store, ai });
  await handle({ text: 'jarvis ceva', sender: 'boss', level: 'private', chatId: 'dm' });
  const offered = ai.calls[0].tools.map((t) => t.function.name);
  assert.ok(offered.includes('groups')); // owner-only command offered to the owner
  assert.ok(offered.includes('ping'));
  store.close();
});

test('ai dispatch: with no AI client wired, an unknown command is just unknown', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store }); // no ai
  const out = toPlain(await handle({ text: 'jarvis salut', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Unknown command/);
  store.close();
});

test('ai dispatch: a non-owner gets AI where the owner turned it on for the chat', async () => {
  const store = createStore({ path: ':memory:' });
  store.scoped('ai-enabled').set('g@g.us', true); // owner opened AI here (via `jarvis ai on`)
  const ai = fakeAi({ command: 'ping', args: {} });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis salut bot', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis ping/);
  assert.match(out, /pong/);
  assert.equal(ai.calls.length, 1);
  store.close();
});

test('ai dispatch: a non-owner gets no AI where it is off (the default)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis salut bot', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Unknown command/);
  assert.equal(ai.calls.length, 0); // AI not consulted for a non-owner where it is off
  store.close();
});

test('ai dispatch: AI cannot escalate - an owner-only command proposed for a non-owner is still refused', async () => {
  const store = createStore({ path: ':memory:' });
  store.scoped('ai-enabled').set('g@g.us', true);
  const ai = fakeAi({ command: 'groups', args: { action: 'deactivate' } }); // owner-only command
  const handle = createDispatcher(createRegistry([ping, groups]), { owner: 'boss', store, ai, listGroups: async () => [] });
  const out = toPlain(await handle({ text: 'jarvis opreste grupul', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Not allowed/i); // the scope guard refuses it even though AI proposed it
  store.close();
});

test('ai dispatch: a multi-step request runs as a chain, echoing every command in order', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi([
    { command: 'blacklist', args: { target: 'note', verb: 'add', person: '*' } },
    { command: 'blacklist', args: { target: 'note', verb: 'enable' } },
  ]);
  const handle = createDispatcher(createRegistry([ping, blacklist, note]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis adauga toti la lista neagra pt note si activeaz-o', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis blacklist note add \* ; jarvis blacklist note enable/); // both echoed, in order
  assert.match(out, /Added everyone to the blacklist for "note"/);
  assert.match(out, /Turned on the blacklist for "note"/);
  store.close();
});

test('ai dispatch: an unusable step in a chain is skipped; the valid steps still run', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi([
    { command: 'schedule', args: {} }, // missing the required action -> dropped during resolution
    { command: 'ping', args: {} }, // valid -> runs
  ]);
  const handle = createDispatcher(createRegistry([ping, schedule]), {
    owner: 'boss', store, ai, scheduler: { list: () => [], add: () => ({}), cancel: () => ({}) },
  });
  const out = toPlain(await handle({ text: 'jarvis fa ceva imposibil si apoi ping', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis ping/); // only the resolvable step is echoed and run
  assert.match(out, /pong/);
  store.close();
});

test('ai dispatch: a destructive command is not auto-run from a translation - the user must type it', async () => {
  const store = createStore({ path: ':memory:' });
  let wiped = 0;
  const ai = fakeAi({ command: 'reset', args: { scope: 'all' } });
  const handle = createDispatcher(createRegistry([ping, reset]), { owner: 'boss', store, ai, lifecycle: { wipe: () => { wiped += 1; } } });
  const out = toPlain(await handle({ text: 'jarvis sterge absolut tot', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Understood: jarvis reset all/); // it shows what it understood
  assert.match(out, /type .*jarvis reset all.* yourself to confirm/i); // but asks the owner to type it
  assert.equal(wiped, 0); // and does NOT execute it from a guess
  store.close();
});

test('ai dispatch: typing a destructive command directly runs it (typing is the confirmation)', async () => {
  const store = createStore({ path: ':memory:' });
  let wiped = 0;
  const handle = createDispatcher(createRegistry([ping, reset]), { owner: 'boss', store, lifecycle: { wipe: () => { wiped += 1; } } });
  const out = toPlain(await handle({ text: 'jarvis reset all', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Wiping all data/i);
  assert.equal(wiped, 1);
  store.close();
});
