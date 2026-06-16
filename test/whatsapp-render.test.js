import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toContent } from '../src/whatsapp/render.js';

test('render: a string becomes a text content object', () => {
  assert.deepEqual(toContent('pong'), { text: 'pong' });
});

test('render: a { text } object passes through; empty mentions are dropped', () => {
  assert.deepEqual(toContent({ text: 'hi' }), { text: 'hi' });
  assert.deepEqual(toContent({ text: 'hi', mentions: [] }), { text: 'hi' });
});

test('render: mentions are kept when present', () => {
  assert.deepEqual(toContent({ text: 'hi @a', mentions: ['1@s.whatsapp.net'] }), {
    text: 'hi @a',
    mentions: ['1@s.whatsapp.net'],
  });
});

test('render: nullish input renders empty text (never throws)', () => {
  assert.deepEqual(toContent(null), { text: '' });
  assert.deepEqual(toContent(undefined), { text: '' });
});
