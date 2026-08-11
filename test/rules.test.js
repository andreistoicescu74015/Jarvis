import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/index.js';
import { createRules, renderTemplate } from '../src/core/rules.js';

test('renderTemplate: fills whitelisted vars, leaves unknown placeholders literal, escapes values', () => {
  assert.equal(renderTemplate('hi {{sender}} in {{chat}}', { sender: 'u', chat: 'gA' }), 'hi u in gA');
  assert.equal(renderTemplate('{{nope}} stays', { sender: 'u' }), '{{nope}} stays'); // unknown left literal
  assert.equal(renderTemplate('plain text', {}), 'plain text');
  // a value cannot inject reply markup - esc defangs WhatsApp markers; this is not a template language
  assert.ok(!renderTemplate('x {{sender}}', { sender: '*boom*' }).includes('*boom*'));
});

test('rules: add validates the keyword and reply, bounds the count, upserts by keyword', () => {
  const store = createStore({ path: ':memory:' });
  const r = createRules(store);
  assert.equal(r.add({ chatId: 'A', keyword: 'bad key', reply: 'x' }).reason, 'bad-keyword');
  assert.equal(r.add({ chatId: 'A', keyword: 'menu', reply: '' }).reason, 'empty-reply');
  assert.equal(r.add({ chatId: 'A', keyword: 'menu', reply: 'soup' }).ok, true);
  assert.equal(r.match('A', 'menu').reply, 'soup');
  assert.equal(r.add({ chatId: 'A', keyword: 'MENU', reply: 'bread' }).ok, true); // upsert, case-insensitive
  assert.equal(r.list('A').length, 1); // not a duplicate
  assert.equal(r.match('A', 'menu').reply, 'bread');
  store.close();
});

test('rules: match / list / remove are chat-scoped', () => {
  const store = createStore({ path: ':memory:' });
  const r = createRules(store);
  r.add({ chatId: 'A', keyword: 'menu', reply: 'a-menu' });
  r.add({ chatId: 'B', keyword: 'menu', reply: 'b-menu' });
  assert.equal(r.match('A', 'menu').reply, 'a-menu');
  assert.equal(r.match('B', 'menu').reply, 'b-menu');
  assert.equal(r.match('A', 'nope'), undefined);
  assert.equal(r.remove('A', 'menu'), true);
  assert.equal(r.match('A', 'menu'), undefined);
  assert.equal(r.match('B', 'menu').reply, 'b-menu'); // B untouched
  store.close();
});

test("rules: clearChat removes only that chat's rules", () => {
  const store = createStore({ path: ':memory:' });
  const r = createRules(store);
  r.add({ chatId: 'A', keyword: 'a1', reply: 'x' });
  r.add({ chatId: 'A', keyword: 'a2', reply: 'y' });
  r.add({ chatId: 'B', keyword: 'b1', reply: 'z' });
  assert.equal(r.clearChat('A'), 2);
  assert.equal(r.list('A').length, 0);
  assert.equal(r.list('B').length, 1);
  store.close();
});

test('rules: a keyword may be a word in the chat\'s own language', () => {
  // The keyword is what someone types after "jarvis", so restricting it to ASCII meant a Romanian
  // group could not use a Romanian word for its own auto-reply.
  const store = createStore({ path: ':memory:' });
  const rules = createRules(store);
  assert.equal(rules.add({ chatId: 'g', keyword: 'mâncare', reply: 'Azi: supa' }).ok, true);
  assert.equal(rules.match('g', 'mâncare').reply, 'Azi: supa');
  assert.equal(rules.match('g', 'MÂNCARE').reply, 'Azi: supa'); // matched case-insensitively, as before
  assert.equal(rules.add({ chatId: 'g', keyword: 'two words', reply: 'x' }).reason, 'bad-keyword');
  assert.equal(rules.add({ chatId: 'g', keyword: 'a|b', reply: 'x' }).reason, 'bad-keyword'); // the key separator
  store.close();
});
