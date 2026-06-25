import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersona } from '../src/core/persona.js';

test('persona: no path -> empty (the default voice is used)', () => {
  assert.equal(loadPersona(''), '');
  assert.equal(loadPersona(undefined), '');
});

test('persona: reads the file with utf8 and trims surrounding whitespace', () => {
  const read = (path, encoding) => {
    assert.equal(path, '/data/persona.md');
    assert.equal(encoding, 'utf8');
    return '  Be terse and formal.\n';
  };
  assert.equal(loadPersona('/data/persona.md', { read }), 'Be terse and formal.');
});

test('persona: an unreadable/missing file degrades to empty, never throws', () => {
  const read = () => { throw new Error('ENOENT'); };
  assert.equal(loadPersona('/missing', { read }), '');
});
