import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketLogger } from '../src/whatsapp/socket-logger.js';

function capture() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
  return { log, lines };
}

test('socketLogger: a real warning surfaces; harmless app-state-sync noise is demoted to debug', () => {
  const { log, lines } = capture();
  const wa = socketLogger(log);
  wa.warn('something actually wrong');
  wa.warn('critical_block blocked on missing key from v0, parking after 2 attempts');
  wa.warn('no name present, ignoring presence update request');
  assert.deepEqual(lines.warn, ['wa: something actually wrong']); // genuine warning kept
  assert.equal(lines.debug.length, 2); // the two known-harmless ones demoted
});

test('socketLogger: errors/fatals map to error; info/debug/trace are dropped', () => {
  const { log, lines } = capture();
  const wa = socketLogger(log);
  wa.error('boom');
  wa.fatal('worse');
  wa.info('chatter');
  wa.trace('chatter');
  assert.deepEqual(lines.error, ['wa: boom', 'wa: worse']);
  assert.equal(lines.info.length, 0);
});

test('socketLogger: the redundant "stream errored out" error is demoted to debug; real errors surface', () => {
  const { log, lines } = capture();
  const wa = socketLogger(log);
  wa.error('stream errored out'); // Baileys logs this at error before every close (e.g. the 515 restart)
  wa.error('boom'); // a genuine error
  assert.deepEqual(lines.error, ['wa: boom']); // real error still surfaces
  assert.deepEqual(lines.debug, ['wa: stream errored out']); // redundant churn demoted
});

test('socketLogger: accepts pino object-or-message call shapes and never throws', () => {
  const { log, lines } = capture();
  const wa = socketLogger(log);
  wa.warn({ some: 'object' }, 'message form');
  wa.child().error('from a child logger');
  assert.deepEqual(lines.warn, ['wa: message form']);
  assert.deepEqual(lines.error, ['wa: from a child logger']);
});
