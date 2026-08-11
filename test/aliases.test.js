import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createAliases } from '../src/core/aliases.js';

test('aliases: define, case-insensitive get, list, and remove', () => {
  const store = createStore({ path: ':memory:' });
  const a = createAliases(store);
  assert.equal(a.define('gm', 'note add Good morning').ok, true);
  assert.equal(a.get('gm'), 'note add Good morning');
  assert.equal(a.get('GM'), 'note add Good morning'); // looked up case-insensitively
  assert.equal(a.get('nope'), undefined);
  assert.deepEqual(a.list(), [{ name: 'gm', target: 'note add Good morning' }]);
  assert.equal(a.remove('gm'), true);
  assert.equal(a.remove('gm'), false); // already gone
  assert.equal(a.get('gm'), undefined);
  store.close();
});

test('aliases: define is an upsert; list is sorted by name', () => {
  const store = createStore({ path: ':memory:' });
  const a = createAliases(store);
  a.define('w', 'whitelist');
  a.define('b', 'blacklist');
  a.define('w', 'whoami'); // overwrite, not a second entry
  assert.equal(a.get('w'), 'whoami');
  assert.deepEqual(a.list().map((x) => x.name), ['b', 'w']);
  store.close();
});

test('aliases: rejects a bad name or an empty target', () => {
  const store = createStore({ path: ':memory:' });
  const a = createAliases(store);
  assert.equal(a.define('two words', 'ping').reason, 'bad-name');
  assert.equal(a.define('', 'ping').reason, 'bad-name');
  assert.equal(a.define('*', 'ping').reason, 'bad-name'); // not a single alnum token
  assert.equal(a.define('gm', '   ').reason, 'empty-target');
  store.close();
});

test('aliases: bounds the target length and the alias count', () => {
  const store = createStore({ path: ':memory:' });
  const a = createAliases(store);
  assert.equal(a.define('x', 'y'.repeat(501)).reason, 'too-long');
  for (let i = 0; i < 200; i++) assert.equal(a.define(`a${i}`, 'ping').ok, true);
  assert.equal(a.define('overflow', 'ping').reason, 'too-many'); // a new one beyond the cap is refused
  assert.equal(a.define('a0', 'pong').ok, true); // but overwriting an existing one is still allowed
  store.close();
});

test('aliases: persist on the same store', () => {
  const store = createStore({ path: ':memory:' });
  createAliases(store).define('hi', 'ping');
  assert.equal(createAliases(store).get('hi'), 'ping'); // a fresh instance over the same store sees it
  store.close();
});

test('aliases: a shortcut may be a word in the owner\'s own language', () => {
  const store = createStore({ path: ':memory:' });
  const aliases = createAliases(store);
  assert.equal(aliases.define('mâncare', 'note add pranz').ok, true);
  assert.equal(aliases.get('mâncare'), 'note add pranz');
  assert.equal(aliases.get('MÂNCARE'), 'note add pranz'); // looked up case-insensitively, as before
  assert.equal(aliases.define('two words', 'ping').reason, 'bad-name');
  store.close();
});
