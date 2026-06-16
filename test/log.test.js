import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, nullLogger } from '../src/core/log.js';

test('log: emits at or above the configured level, drops below', () => {
  const lines = [];
  const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[warn\] w$/);
  assert.match(lines[1], /\[error\] e$/);
});

test('log: serializes structured fields as JSON', () => {
  const lines = [];
  const log = createLogger({ level: 'info', sink: (l) => lines.push(l) });
  log.info('hello', { a: 1, b: 'x' });
  assert.match(lines[0], /\[info\] hello \{"a":1,"b":"x"\}/);
});

test('log: each line is timestamped', () => {
  const lines = [];
  const log = createLogger({ level: 'info', sink: (l) => lines.push(l) });
  log.info('tick');
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] tick$/);
});

test('log: nullLogger swallows everything without throwing', () => {
  assert.doesNotThrow(() => {
    nullLogger.debug('x');
    nullLogger.info('x');
    nullLogger.warn('x');
    nullLogger.error('x', { k: 1 });
  });
});
