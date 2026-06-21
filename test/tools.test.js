import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands/index.js';
import { createRegistry } from '../src/core/registry.js';
import { toolCatalog, toCommandLine } from '../src/core/tools.js';

const reg = createRegistry(commands);
const get = (n) => reg.get(n);
const names = (cat) => cat.map((t) => t.function.name);

test('toolCatalog: only includes commands the caller may run (by scope)', () => {
  const owner = toolCatalog(commands, { level: 'private', isAdmin: false, isOwner: true });
  const stranger = toolCatalog(commands, { level: 'private', isAdmin: false, isOwner: false });
  assert.ok(names(owner).includes('groups')); // owner-only -> visible to the owner
  assert.ok(!names(stranger).includes('groups')); // hidden from a non-owner (would just be refused)
  assert.ok(names(stranger).includes('ping')); // open commands stay visible to everyone
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
});

test('toCommandLine: throws on a missing required param; empty for an unknown command', () => {
  assert.throws(() => toCommandLine(get('schedule'), {}), /missing required/);
  assert.equal(toCommandLine(undefined, { x: 1 }), '');
});
