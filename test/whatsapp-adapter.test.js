import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWhatsAppAdapter } from '../src/whatsapp/adapter.js';

function fakeAuthState() {
  return { state: {}, saveCreds() {}, cleared: 0, clear() { this.cleared += 1; } };
}

/** A makeSocket stub that records every socket it builds. */
function fakeSocketFactory() {
  const make = () => {
    const sock = {
      ev: new EventEmitter(),
      user: { id: '1234:5@s.whatsapp.net' },
      sent: [],
      presence: [],
      ended: false,
      sendMessage: async (jid, content) => { sock.sent.push({ jid, content }); },
      sendPresenceUpdate: async (state, jid) => { sock.presence.push({ state, jid }); },
      groupMetadata: async () => ({ participants: [] }),
      end: () => { sock.ended = true; },
    };
    make.sockets.push(sock);
    return sock;
  };
  make.sockets = [];
  return make;
}

const opts = (over) => ({
  authState: fakeAuthState(),
  makeSocket: fakeSocketFactory(),
  sleep: async () => {},
  renderQr: () => {},
  random: () => 0,
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

test('adapter: exposes the Adapter contract', () => {
  const a = createWhatsAppAdapter(opts());
  assert.equal(typeof a.start, 'function');
  assert.equal(typeof a.send, 'function');
  assert.equal(typeof a.stop, 'function');
});

test('adapter: learns identity pairs from every inbound key (even non-commands)', async () => {
  const makeSocket = fakeSocketFactory();
  const learned = [];
  const a = createWhatsAppAdapter(opts({ makeSocket, learn: (key) => learned.push(key) }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { remoteJid: 'G@g.us', participant: '111@lid', participantPn: '40712@s.whatsapp.net' }, message: { conversation: 'hello' } }],
  });
  await tick();
  assert.equal(learned.length, 1);
  assert.equal(learned[0].participant, '111@lid');
});

test('adapter: only addressed inbound reaches onMessage; mention becomes a bare command', async () => {
  const makeSocket = fakeSocketFactory();
  const received = [];
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async (m) => { received.push(m); } });

  makeSocket.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: '9@s.whatsapp.net', fromMe: false }, message: { conversation: 'jarvis ping' } },
      { key: { remoteJid: '9@s.whatsapp.net', fromMe: true }, message: { conversation: 'jarvis ping' } }, // fromMe -> dropped
      { key: { remoteJid: '9@s.whatsapp.net' }, message: { conversation: 'hello' } }, // not addressed -> dropped
      {
        key: { remoteJid: '9@s.whatsapp.net' },
        message: { extendedTextMessage: { text: '@1234 ping', contextInfo: { mentionedJid: ['1234@s.whatsapp.net'] } } },
      },
    ],
  });
  await tick();

  assert.equal(received.length, 2);
  assert.equal(received[0].text, 'jarvis ping');
  assert.equal(received[0].addressed, false); // prefix path
  assert.equal(received[1].text, 'ping'); // mention stripped
  assert.equal(received[1].addressed, true); // bare command
});

test('adapter: non-notify upserts are ignored', async () => {
  const makeSocket = fakeSocketFactory();
  const received = [];
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async (m) => { received.push(m); } });
  makeSocket.sockets[0].ev.emit('messages.upsert', {
    type: 'append',
    messages: [{ key: { remoteJid: '9@s.whatsapp.net' }, message: { conversation: 'jarvis ping' } }],
  });
  await tick();
  assert.equal(received.length, 0);
});

test('adapter: send renders content and brackets it with presence updates', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });

  await a.send('9@s.whatsapp.net', 'pong');
  assert.deepEqual(makeSocket.sockets[0].sent, [{ jid: '9@s.whatsapp.net', content: { text: 'pong' } }]);
  assert.deepEqual(makeSocket.sockets[0].presence.map((p) => p.state), ['composing', 'paused']);
});

test('adapter: 515 restartRequired recreates the socket; 401 loggedOut wipes and stops', async () => {
  const makeSocket = fakeSocketFactory();
  const authState = fakeAuthState();
  const a = createWhatsAppAdapter(opts({ makeSocket, authState }));
  a.start({ onMessage: async () => {} });
  assert.equal(makeSocket.sockets.length, 1);

  makeSocket.sockets[0].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 } } },
  });
  await tick();
  assert.equal(makeSocket.sockets.length, 2); // new socket

  makeSocket.sockets[1].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  await tick();
  assert.equal(makeSocket.sockets.length, 2); // no reconnect after logout
  assert.equal(authState.cleared, 1); // creds wiped
});
