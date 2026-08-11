import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands/index.js';
import { createRegistry } from '../src/core/registry.js';
import { toolCatalog, toCommandLine } from '../src/core/tools.js';

const reg = createRegistry(commands);
const get = (n) => reg.get(n);
const names = (cat) => cat.map((t) => t.function.name);

test('toCommandLine: the trailing variadic param carries a value with spaces (a group name)', () => {
  // Groups are named by NAME now, and names have spaces. A non-variadic argument is refused for
  // containing one, so the model could only ever name single-word groups while typing worked for any.
  assert.equal(toCommandLine(get('groups'), { action: 'activate', id: 'Anul 3 Info' }), 'groups activate Anul 3 Info');
  assert.equal(toCommandLine(get('groups'), { action: 'deactivate', id: 'Beta' }), 'groups deactivate Beta');
  assert.equal(toCommandLine(get('groups'), { action: 'activate' }), 'groups activate'); // still optional
});

test('toolCatalog: only includes commands the caller may run (by scope)', () => {
  const owner = toolCatalog(commands, { level: 'private', isAdmin: false, isOwner: true });
  const stranger = toolCatalog(commands, { level: 'private', isAdmin: false, isOwner: false });
  assert.ok(names(owner).includes('groups')); // owner-only -> visible to the owner
  assert.ok(!names(stranger).includes('groups')); // hidden from a non-owner (would just be refused)
  assert.ok(names(stranger).includes('ping')); // open commands stay visible to everyone
  assert.ok(!names(stranger).includes('link')); // group-only -> hidden from a private chat
  const groupAdmin = toolCatalog(commands, { level: 'group', isAdmin: true, isOwner: false });
  assert.ok(names(groupAdmin).includes('link')); // ...but offered to an admin in a group
});

test('toolCatalog: emits the OpenAI tool shape with the param schema (enum + required)', () => {
  const cat = toolCatalog(commands, { level: 'private', isAdmin: false, isOwner: true });
  const schedule = cat.find((t) => t.function.name === 'schedule');
  assert.equal(schedule.type, 'function');
  assert.equal(schedule.function.parameters.type, 'object');
  assert.deepEqual(schedule.function.parameters.required, ['action']); // action is required
  assert.ok(schedule.function.parameters.properties.action.enum.includes('in')); // enum carried through
  assert.equal(schedule.function.parameters.additionalProperties, false);
});

test('toCommandLine: rebuilds the canonical command from a tool call', () => {
  assert.equal(toCommandLine(get('whitelist'), { target: '*', verb: 'enable' }), 'whitelist * enable');
  assert.equal(toCommandLine(get('note'), { action: 'add', text: 'buy milk' }), 'note add buy milk'); // variadic keeps spaces
  assert.equal(toCommandLine(get('reset'), { scope: 'all' }), 'reset all');
});

test('toCommandLine: omits absent optional params; a bare command when none are given', () => {
  assert.equal(toCommandLine(get('groups'), {}), 'groups');
  assert.equal(toCommandLine(get('groups'), { action: 'activate' }), 'groups activate');
  assert.equal(toCommandLine(get('owner'), {}), 'owner');
  // A later optional arg with an EARLIER one omitted must NOT slide into the earlier slot: stop at the gap.
  assert.equal(toCommandLine(get('groups'), { id: 'g@g.us' }), 'groups');
});

test('toCommandLine: throws on a missing required param; empty for an unknown command', () => {
  assert.throws(() => toCommandLine(get('schedule'), {}), /missing required/);
  assert.equal(toCommandLine(undefined, { x: 1 }), '');
});

test('toCommandLine: refuses a multi-word value in a NON-variadic slot (it would shift on re-parse)', () => {
  // e.g. the model fills person="John Doe" for `whitelist <target> <verb> <person>`: rebuilt and
  // re-parsed, "Doe" would spill into the next positional slot and the command would run with a
  // different meaning than the echoed line - so the proposal is refused instead.
  assert.throws(() => toCommandLine(get('whitelist'), { target: '*', verb: 'add', person: 'John Doe' }), /single token/);
  // a variadic tail keeps accepting free text with spaces
  assert.equal(toCommandLine(get('note'), { action: 'add', text: 'buy some milk' }), 'note add buy some milk');
});
