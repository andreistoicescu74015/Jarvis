import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b, i, strike, mono, code, bullet, number, quote, esc, toWhatsApp, toPlain } from '../src/core/format.js';

const ZWSP = String.fromCharCode(0x200b);

test('format: builders render to WhatsApp syntax and to clean plain text', () => {
  assert.equal(toWhatsApp(b('x')), '*x*');
  assert.equal(toWhatsApp(i('x')), '_x_');
  assert.equal(toWhatsApp(strike('x')), '~x~');
  assert.equal(toWhatsApp(mono('id')), '```id```'); // monospace block = triple backtick
  assert.equal(toWhatsApp(code('cmd')), '`cmd`'); // inline code = single backtick
  assert.equal(toPlain(b('x')), 'x'); // CLI strips all markup
  assert.equal(toPlain(`${b('A')} ${code('B')} ${mono('C')}`), 'A B C');
});

test('format: a plain string is unchanged by either renderer', () => {
  assert.equal(toWhatsApp('hello world'), 'hello world');
  assert.equal(toPlain('hello world'), 'hello world');
});

test('format: lists and quotes are plain decorations on both platforms', () => {
  assert.equal(bullet(['a', 'b']), '- a\n- b');
  assert.equal(number(['a', 'b']), '1. a\n2. b');
  assert.equal(quote('one\ntwo'), '> one\n> two');
});

test('format: esc strips our sentinels so user content cannot inject styling', () => {
  const injected = esc(`${b('evil')}`); // a user trying to embed a bold span
  assert.equal(toWhatsApp(injected), 'evil'); // no '*' produced - the sentinels were stripped
});

test('format: esc defangs WhatsApp markers in user content so they cannot hijack formatting', () => {
  const out = toWhatsApp(`${b('Notes')}: ${esc('call *Bob*')}`);
  assert.match(out, /^\*Notes\*: /); // the command's own bold still renders
  assert.ok(out.includes(`*${ZWSP}`), 'a user asterisk is broken with a zero-width space');
  assert.ok(toWhatsApp(esc('run `ls`')).includes(`\`${ZWSP}`), 'a user backtick is broken too (inline-code marker)');
});
