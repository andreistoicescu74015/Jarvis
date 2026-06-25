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
import owner from '../src/commands/owner.js';

const ping = { name: 'ping', summary: 'p', run: () => 'pong' };

/**
 * A fake AI client returning a canned chain (or a function of the input) and an optional chat answer.
 * Records every call (incl. the `chat` flag) so tests can assert what was requested.
 */
function fakeAi(proposal, answer = null, usage = null) {
  const calls = [];
  return {
    calls,
    translate: async ({ text, tools, chat }) => {
      calls.push({ text, tools, chat });
      const p = typeof proposal === 'function' ? proposal(text, tools) : proposal;
      const commands = p == null ? [] : Array.isArray(p) ? p : [p];
      const out = { commands, answer: typeof answer === 'function' ? answer(text) : answer };
      if (usage) out.usage = usage;
      return out;
    },
  };
}

test('ai dispatch: a natural-language request is translated, run, and echoed as the command', async () => {
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

test('ai dispatch: translation is always on - a non-owner gets it too (no opt-in needed)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis salut bot', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis ping/);
  assert.match(out, /pong/);
  assert.equal(ai.calls.length, 1); // a non-owner DID consult AI (translation is a standing feature)
  store.close();
});

test('ai dispatch: when nothing maps and chatbot is off, a friendly nudge (not a blunt error)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi(null); // no command matched
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis qwerty zxcv', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /didn't catch a command/i);
  assert.equal(ai.calls.length, 1);
  store.close();
});

test('ai dispatch: an incomplete translation (missing a required arg) falls back, never half-runs', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'schedule', args: {} }); // schedule.action is required
  const handle = createDispatcher(createRegistry([ping, schedule]), { owner: 'boss', store, scheduler: { list: () => [], add: () => ({}), cancel: () => ({}) }, ai });
  const out = toPlain(await handle({ text: 'jarvis programeaza ceva', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /didn't catch a command/i); // the incomplete tool call is dropped
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

test('ai dispatch: chatbot mode on - a general question gets a conversational answer', async () => {
  const store = createStore({ path: ':memory:' });
  store.scoped('ai-enabled').set('g@g.us', true); // owner turned chatbot on here (`jarvis ai on`)
  const ai = fakeAi(null, 'A lemon is about 7 cm.'); // nothing maps; the model answers
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis how big is a lemon', sender: 'u', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /A lemon is about 7 cm/);
  assert.equal(ai.calls[0].chat, true); // chat mode was requested
  store.close();
});

test('ai dispatch: chatbot mode off (default) - a general question gets the friendly nudge, not an answer', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi(null, 'A lemon is about 7 cm.'); // the model could answer, but chat mode is off
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis how big is a lemon', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /didn't catch a command/i);
  assert.doesNotMatch(out, /A lemon/); // the answer is withheld
  assert.equal(ai.calls[0].chat, false); // chat mode was not requested
  store.close();
});

test('ai dispatch: AI cannot escalate - an owner-only command proposed for a non-owner is still refused', async () => {
  const store = createStore({ path: ':memory:' });
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

test('ai dispatch: a sensitive command (reset) is not auto-run from a translation - the user must type it', async () => {
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

test('ai dispatch: typing a sensitive command directly runs it (typing is the confirmation)', async () => {
  const store = createStore({ path: ':memory:' });
  let wiped = 0;
  const handle = createDispatcher(createRegistry([ping, reset]), { owner: 'boss', store, lifecycle: { wipe: () => { wiped += 1; } } });
  const out = toPlain(await handle({ text: 'jarvis reset all', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Wiping all data/i);
  assert.equal(wiped, 1);
  store.close();
});

test('ai dispatch: a destructive SUBCOMMAND (note clear) is not auto-run from a translation', async () => {
  const store = createStore({ path: ':memory:' });
  store.scoped('private:dm').set('notes', ['keep me']); // a pre-existing note
  const ai = fakeAi({ command: 'note', args: { action: 'clear' } });
  const handle = createDispatcher(createRegistry([ping, note]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis sterge toate notitele', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Understood: jarvis note clear/);
  assert.match(out, /type .*jarvis note clear.* yourself to confirm/i);
  assert.deepEqual(store.scoped('private:dm').get('notes'), ['keep me']); // NOT wiped
  store.close();
});

test('ai dispatch: a non-destructive subcommand (note add) still runs from a translation', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'note', args: { action: 'add', text: 'from ai' } });
  const handle = createDispatcher(createRegistry([ping, note]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis noteaza from ai', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Understood: jarvis note add from ai/);
  assert.match(out, /Added note #1/); // the benign verb is auto-run
  assert.deepEqual(store.scoped('private:dm').get('notes'), ['from ai']);
  store.close();
});

test('ai dispatch: groups deactivate is not auto-run from a translation even for the owner', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'groups', args: { action: 'deactivate' } });
  const handle = createDispatcher(createRegistry([ping, groups]), {
    owner: 'boss', store, ai, listGroups: async () => [{ id: 'g@g.us', name: 'G' }],
  });
  const out = toPlain(await handle({ text: 'jarvis opreste grupul asta', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /Understood: jarvis groups deactivate/);
  assert.match(out, /type .*jarvis groups deactivate.* yourself to confirm/i); // the full group reset must be typed
  store.close();
});

test('ai dispatch: the owner command is sensitive - it is suggested, not auto-run', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'owner', args: { action: 'resign' } });
  const handle = createDispatcher(createRegistry([ping, owner]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis renunta la rolul de owner', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /Understood: jarvis owner resign/);
  assert.match(out, /type .*jarvis owner resign.* yourself to confirm/i);
  store.close();
});

test('ai dispatch: an over-long command chain is capped', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi(Array.from({ length: 12 }, () => ({ command: 'ping', args: {} })));
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis fa ping de multe ori', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.equal((out.match(/pong/g) || []).length, 8); // only AI_MAX_CHAIN (8) steps execute, not all 12
  store.close();
});

test('ai dispatch: a translator that throws falls back to a friendly reply (never crashes)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = { translate: async () => { throw new Error('boom'); } };
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis ceva ce arunca', sender: 'boss', level: 'private', chatId: 'dm' }));
  assert.match(out, /didn't catch a command/i);
  store.close();
});

test('ai dispatch: a mis-used known command gets an AI suggestion of what was meant (not auto-run)', async () => {
  const store = createStore({ path: ':memory:' });
  // A known command (whitelist) typed with natural-language args it cannot parse - a "misuse". The
  // dispatcher asks the AI what was likely meant and appends it as a suggestion; it does NOT run it.
  const ai = fakeAi({ command: 'whitelist', args: { target: '*', verb: 'disable' } });
  const handle = createDispatcher(createRegistry([ping, whitelist]), { owner: 'boss', store, ai });
  const out = toPlain(await handle({ text: 'jarvis whitelist opreste lista asta', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /No such command: opreste/i); // the original error is still shown
  assert.match(out, /Did you mean: .*jarvis whitelist \* disable.*Type it to run/i); // plus a suggestion
  assert.equal(store.scoped('access').get('*|g@g.us'), undefined); // nothing was applied (suggestion only)
  store.close();
});

test('ai dispatch: a mis-used command with no AI wired just shows the usage (no suggestion)', async () => {
  const store = createStore({ path: ':memory:' });
  const handle = createDispatcher(createRegistry([ping, whitelist]), { owner: 'boss', store }); // no ai
  const out = toPlain(await handle({ text: 'jarvis whitelist opreste lista asta', sender: 'boss', level: 'group', chatId: 'g@g.us' }));
  assert.match(out, /No such command: opreste/i);
  assert.doesNotMatch(out, /Did you mean/i);
  store.close();
});

test('ai dispatch: token usage reported by the model is recorded per-context and globally', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} }, null, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  await handle({ text: 'jarvis fa un ping', sender: 'u', level: 'group', chatId: 'g@g.us' });
  assert.equal(store.scoped('ai-usage').get('g@g.us').total, 30); // per-context (the chat id)
  assert.equal(store.scoped('ai-usage').get('g@g.us').calls, 1);
  assert.equal(store.scoped('ai-usage').get('*').total, 30); // and the running global total
  store.close();
});

test('ai dispatch: a deterministic command records no AI usage (the model is never called)', async () => {
  const store = createStore({ path: ':memory:' });
  const ai = fakeAi({ command: 'ping', args: {} }, null, { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
  const handle = createDispatcher(createRegistry([ping]), { owner: 'boss', store, ai });
  await handle({ text: 'jarvis ping', sender: 'boss', level: 'private', chatId: 'dm' });
  assert.equal(store.scoped('ai-usage').get('*'), undefined); // a known command short-circuits before any AI call
  store.close();
});
