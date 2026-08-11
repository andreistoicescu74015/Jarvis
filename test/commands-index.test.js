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

// A manual page is rendered WITHOUT escaping, so it can carry its own formatting. The flip side is
// that a literal *, _, ~ or backtick left in one becomes a live WhatsApp marker for the reader:
// a plain GITHUB_MODELS_TOKEN comes out with MODELS in italics. Inside a monospace span WhatsApp
// applies no other formatting, so a marker there is safe - and that is where such names belong.
// The sentinels are built from char codes so this file stays plain ASCII, like the rest of the repo.
const CODE = String.fromCharCode(5); // what format.js `code(...)` wraps its text in
const MONO = String.fromCharCode(4); // and `mono(...)`
const SENTINELS = new RegExp(`[${String.fromCharCode(1)}-${String.fromCharCode(5)}]`, 'g');
const plainPartOf = (man) =>
  man
    .replace(new RegExp(`${CODE}[^${CODE}]*${CODE}`, 'g'), '')
    .replace(new RegExp(`${MONO}[^${MONO}]*${MONO}`, 'g'), '')
    .replace(SENTINELS, ''); // bold/italic sentinels are our markup, not markers the reader sees

test('commands manifest: no manual page leaves a live WhatsApp marker in plain text', () => {
  for (const c of commands) {
    if (!c.man) continue;
    const offenders = plainPartOf(c.man).split(/\s+/).filter((w) => /[*_~`]/.test(w));
    assert.deepEqual(offenders, [], `${c.name}: wrap these in code() so they render literally - ${offenders.join(' ')}`);
  }
});
