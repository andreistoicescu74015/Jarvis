import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands/index.js';
import { createRegistry } from '../src/core/registry.js';

test('commands manifest: builds a valid registry of unique, named commands', () => {
  assert.ok(commands.length >= 14, 'manifest should hold the full command set');
  const registry = createRegistry(commands); // throws on a bad/duplicate command
  for (const c of commands) assert.equal(registry.get(c.name), c);
  for (const name of ['ping', 'help', 'man', 'note', 'schedule', 'owner', 'groups']) {
    assert.ok(registry.has(name), `manifest should include ${name}`);
  }
});
