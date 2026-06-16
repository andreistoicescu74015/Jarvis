import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisconnectReason } from 'baileys';
import { disconnectAction, backoffMs } from '../src/whatsapp/connection.js';

test('connection: disconnectAction maps status codes to lifecycle actions', () => {
  assert.equal(disconnectAction(DisconnectReason.loggedOut), 'logout'); // 401
  assert.equal(disconnectAction(DisconnectReason.restartRequired), 'restart'); // 515
  assert.equal(disconnectAction(DisconnectReason.connectionClosed), 'reconnect'); // 428
  assert.equal(disconnectAction(undefined), 'reconnect');
});

test('connection: backoffMs grows with attempts and respects the cap (full jitter)', () => {
  assert.equal(backoffMs(0, { rand: () => 0.5, baseMs: 1000 }), 500); // base * 2^0 * 0.5
  assert.equal(backoffMs(2, { rand: () => 0.5, baseMs: 1000 }), 2000); // base * 2^2 * 0.5
  assert.equal(backoffMs(0, { rand: () => 0 }), 0);
  assert.equal(backoffMs(100, { rand: () => 0.5, capMs: 30000 }), 15000); // capped at 30000 * 0.5
});
