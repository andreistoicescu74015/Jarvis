import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisconnectReason } from 'baileys';
import { disconnectAction, stopReason, backoffMs } from '../src/whatsapp/connection.js';

test('connection: disconnectAction maps status codes to lifecycle actions', () => {
  assert.equal(disconnectAction(DisconnectReason.loggedOut), 'logout'); // 401
  assert.equal(disconnectAction(DisconnectReason.restartRequired), 'restart'); // 515
  assert.equal(disconnectAction(DisconnectReason.connectionClosed), 'reconnect'); // 428
  assert.equal(disconnectAction(undefined), 'reconnect');
});

test('connection: terminal codes stop instead of reconnecting (no fight / no hammer)', () => {
  assert.equal(disconnectAction(DisconnectReason.connectionReplaced), 'stop'); // 440 another session
  assert.equal(disconnectAction(DisconnectReason.forbidden), 'stop'); // 403 banned/blocked
  assert.equal(disconnectAction(DisconnectReason.badSession), 'stop'); // 500 unrecoverable
});

test('connection: stopReason names the terminal cause', () => {
  assert.equal(stopReason(DisconnectReason.connectionReplaced), 'replaced');
  assert.equal(stopReason(DisconnectReason.forbidden), 'forbidden');
  assert.equal(stopReason(DisconnectReason.badSession), 'badSession');
  assert.equal(stopReason(DisconnectReason.connectionClosed), 'stopped'); // not terminal -> generic
});

test('connection: backoffMs grows with attempts and respects the cap (full jitter)', () => {
  assert.equal(backoffMs(0, { rand: () => 0.5, baseMs: 1000 }), 500); // base * 2^0 * 0.5
  assert.equal(backoffMs(2, { rand: () => 0.5, baseMs: 1000 }), 2000); // base * 2^2 * 0.5
  assert.equal(backoffMs(0, { rand: () => 0 }), 0);
  assert.equal(backoffMs(100, { rand: () => 0.5, capMs: 30000 }), 15000); // capped at 30000 * 0.5
});
