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

test('commands manifest: every command documents itself (summary, usage, and a man page)', () => {
  // `man <command>` is the in-chat manual, so a command without one answers with a single line and
  // sends the reader to the README. Guarding it here keeps a new command from shipping undocumented.
  for (const c of commands) {
    assert.ok(c.summary?.trim(), `${c.name} needs a summary`);
    assert.ok(c.usage?.trim(), `${c.name} needs a usage line`);
    assert.ok(c.man?.trim(), `${c.name} needs a man text`);
    assert.ok(c.usage.startsWith('jarvis '), `${c.name} usage should read as a typed line`);
  }
});
