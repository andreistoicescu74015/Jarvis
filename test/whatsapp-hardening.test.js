import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWhatsAppAdapter } from '../src/whatsapp/adapter.js';

const tick = () => new Promise((r) => setImmediate(r));
const fakeAuthState = () => ({ state: {}, saveCreds() {}, cleared: 0, clear() { this.cleared += 1; } });

/** makeSocket stub; each socket counts groupMetadata fetches. */
function fakeSocketFactory() {
  const make = () => {
    const sock = {
      ev: new EventEmitter(),
      user: { id: '1234:5@s.whatsapp.net' },
      sent: [],
      groupMetadataCalls: 0,
      sendMessage: async () => {},
      sendPresenceUpdate: async () => {},
      groupMetadata: async () => {
        sock.groupMetadataCalls += 1;
        return { participants: [{ id: '9@s.whatsapp.net', admin: 'admin' }] };
      },
      end: () => {},
    };
    make.sockets.push(sock);
    return sock;
  };
  make.sockets = [];
  return make;
}

const base = (over) => ({
  authState: fakeAuthState(),
  makeSocket: fakeSocketFactory(),
  sleep: async () => {},
  renderQr: () => {},
  random: () => 0,
  ...over,
});

test('hardening: the offline backlog is skipped; fresh and timestamp-less messages pass', async () => {
  let clock = 10_000_000;
  const makeSocket = fakeSocketFactory();
  const received = [];
  const a = createWhatsAppAdapter(base({ makeSocket, now: () => clock }));
  a.start({ onMessage: async (m) => received.push(m) });
  const sock = makeSocket.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' }); // connectedAt = 10_000_000ms

  const sec = Math.floor(clock / 1000);
  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: 'A@s.whatsapp.net' }, messageTimestamp: sec - 3600, message: { conversation: 'jarvis ping' } }, // backlog -> skip
      { key: { remoteJid: 'B@s.whatsapp.net' }, messageTimestamp: sec, message: { conversation: 'jarvis ping' } }, // fresh -> pass
      { key: { remoteJid: 'C@s.whatsapp.net' }, message: { conversation: 'jarvis ping' } }, // no timestamp -> pass
    ],
  });
  await tick();

  assert.deepEqual(received.map((m) => m.chatId), ['B@s.whatsapp.net', 'C@s.whatsapp.net']);
});

test('hardening: group metadata is cached with a TTL, then refetched after it expires', async () => {
  let clock = 1_000_000;
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(base({ makeSocket, now: () => clock, groupCacheTtlMs: 60_000 }));
  a.start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' });
  const groupMsg = { type: 'notify', messages: [{ key: { remoteJid: 'G@g.us', participant: '9@s.whatsapp.net' }, message: { conversation: 'jarvis ping' } }] };

  sock.ev.emit('messages.upsert', groupMsg);
  await tick();
  assert.equal(sock.groupMetadataCalls, 1); // first fetch

  sock.ev.emit('messages.upsert', groupMsg);
  await tick();
  assert.equal(sock.groupMetadataCalls, 1); // served from cache

  clock += 61_000; // past the TTL
  sock.ev.emit('messages.upsert', groupMsg);
  await tick();
  assert.equal(sock.groupMetadataCalls, 2); // refetched
});

test('hardening: a participant update invalidates the cached group metadata', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(base({ makeSocket, now: () => 0, groupCacheTtlMs: 60_000 }));
  a.start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' });
  const groupMsg = { type: 'notify', messages: [{ key: { remoteJid: 'G@g.us', participant: '9@s.whatsapp.net' }, message: { conversation: 'jarvis ping' } }] };

  sock.ev.emit('messages.upsert', groupMsg);
  await tick();
  assert.equal(sock.groupMetadataCalls, 1);

  sock.ev.emit('group-participants.update', { id: 'G@g.us' }); // admin change -> invalidate
  sock.ev.emit('messages.upsert', groupMsg);
  await tick();
  assert.equal(sock.groupMetadataCalls, 2); // refetched despite TTL not elapsed
});

test('hardening: logout wipes creds and signals a clean exit (no reconnect)', async () => {
  const makeSocket = fakeSocketFactory();
  const authState = fakeAuthState();
  let logoutCalls = 0;
  const a = createWhatsAppAdapter(base({ makeSocket, authState, onLogout: () => { logoutCalls += 1; } }));
  a.start({ onMessage: async () => {} });

  makeSocket.sockets[0].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await tick();

  assert.equal(authState.cleared, 1);
  assert.equal(logoutCalls, 1);
  assert.equal(makeSocket.sockets.length, 1); // did not reconnect
});
