import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closest } from '../src/core/closest.js';

const NAMES = ['ping', 'help', 'note', 'schedule', 'whitelist', 'ai', 'reset', 'logout'];

test('closest: a one-edit typo resolves to the command', () => {
  assert.equal(closest('pingg', NAMES), 'ping'); // extra letter
  assert.equal(closest('scedule', NAMES), 'schedule'); // missing letter
  assert.equal(closest('halp', NAMES), 'help'); // substitution
});

test('closest: a two-edit typo of a longer command still resolves (transposition)', () => {
  assert.equal(closest('scheduel', NAMES), 'schedule'); // transposed -> distance 2
});

test('closest: an exact name returns itself', () => {
  assert.equal(closest('note', NAMES), 'note');
});

test('closest: far-off, empty, or too-short input returns null', () => {
  assert.equal(closest('frobnicate', NAMES), null); // not close to any
  assert.equal(closest('hi', NAMES), null); // < 3 chars: never fuzzy-matched
  assert.equal(closest('', NAMES), null);
  assert.equal(closest('weather', NAMES), null); // a real word, but not a near-miss
});

test('closest: short tokens allow only one edit (no over-eager matches)', () => {
  // "hxlx" is 2 edits from "help" - too far for a 4-char token, whose budget is 1.
  assert.equal(closest('hxlx', NAMES), null);
});

test('closest: an ambiguous tie returns null (no guess between equals)', () => {
  assert.equal(closest('cat', ['bat', 'car']), null); // both one edit away
});
