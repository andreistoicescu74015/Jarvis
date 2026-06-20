import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWhatsAppAdapter } from '../src/whatsapp/adapter.js';

function fakeAuthState() {
  return { state: {}, saveCreds() {}, cleared: 0, clear() { this.cleared += 1; } };
}

/** A makeSocket stub that records every socket it builds. */
function fakeSocketFactory() {
  const make = (config) => {
    const sock = {
      config,
      ev: new EventEmitter(),
      user: { id: '1234:5@s.whatsapp.net' },
      sent: [],
      presence: [],
      read: [],
      ended: false,
      sendMessage: async (jid, content) => { sock.sent.push({ jid, content }); },
      sendPresenceUpdate: async (state, jid) => { sock.presence.push({ state, jid }); },
      readMessages: async (keys) => { sock.read.push(...keys); },
      updateProfileName: async (name) => { sock.named = name; sock.user.name = name; },
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

test('adapter: a transient close reconnects with backoff up to a cap, then gives up (onFatal)', async () => {
  const makeSocket = fakeSocketFactory();
  const fatals = [];
  const a = createWhatsAppAdapter(opts({ makeSocket, onFatal: (r) => fatals.push(r), maxReconnects: 3 }));
  a.start({ onMessage: async () => {} });

  // each transient close (status 428, no 'open' in between) recreates the socket, up to the cap
  for (let i = 0; i < 3; i++) {
    makeSocket.sockets.at(-1).ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await tick();
  }
  assert.equal(makeSocket.sockets.length, 4); // 1 initial + 3 reconnects
  assert.deepEqual(fatals, []); // not given up yet

  // the next consecutive failure exceeds the cap -> stop, no new socket, onFatal('exhausted')
  makeSocket.sockets.at(-1).ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 428 } } },
  });
  await tick();
  assert.equal(makeSocket.sockets.length, 4); // no further reconnect
  assert.deepEqual(fatals, ['exhausted']);
});

test('adapter: a successful open resets the reconnect counter', async () => {
  const makeSocket = fakeSocketFactory();
  const fatals = [];
  const a = createWhatsAppAdapter(opts({ makeSocket, onFatal: (r) => fatals.push(r), maxReconnects: 2 }));
  a.start({ onMessage: async () => {} });

  makeSocket.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  makeSocket.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); // reconnected -> reset
  await tick();
  // after a reset we can fail twice more before the cap, proving the counter cleared
  makeSocket.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  assert.deepEqual(fatals, []); // would have been 'exhausted' if the counter had not reset
});

test('adapter: a fatal close (replaced/forbidden/badSession) stops without reconnecting', async () => {
  for (const [code, reason] of [[440, 'replaced'], [403, 'forbidden'], [500, 'badSession']]) {
    const makeSocket = fakeSocketFactory();
    const fatals = [];
    const a = createWhatsAppAdapter(opts({ makeSocket, onFatal: (r) => fatals.push(r) }));
    a.start({ onMessage: async () => {} });
    makeSocket.sockets[0].ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: code } } },
    });
    await tick();
    assert.equal(makeSocket.sockets.length, 1, `code ${code}: no reconnect`);
    assert.deepEqual(fatals, [reason], `code ${code}: onFatal(${reason})`);
  }
});

test('adapter: being removed from a group signals deactivation (only when it is the bot)', async () => {
  const makeSocket = fakeSocketFactory();
  const removed = [];
  const a = createWhatsAppAdapter(opts({ makeSocket, onRemoved: (id) => removed.push(id) }));
  a.start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0]; // user.id '1234:5@s.whatsapp.net' -> 1234@s.whatsapp.net

  sock.ev.emit('group-participants.update', { id: 'G@g.us', action: 'remove', participants: ['1234@s.whatsapp.net'] });
  await tick();
  assert.deepEqual(removed, ['G@g.us']); // the bot itself was removed

  sock.ev.emit('group-participants.update', { id: 'G@g.us', action: 'remove', participants: ['9999@s.whatsapp.net'] });
  await tick();
  assert.deepEqual(removed, ['G@g.us']); // someone else leaving is not our removal

  sock.ev.emit('group-participants.update', { id: 'G2@g.us', action: 'add', participants: ['1234@s.whatsapp.net'] });
  await tick();
  assert.deepEqual(removed, ['G@g.us']); // an add is not a removal
});

test('adapter: a close from a socket a reconnect already replaced is ignored (no double-connect)', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });

  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  assert.equal(makeSocket.sockets.length, 2); // reconnected to a fresh socket

  // the now-stale socket[0] fires a late close - it must NOT spawn a third socket
  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  assert.equal(makeSocket.sockets.length, 2);
});

test('adapter: listGroups maps participating groups to {id, name} (id when no subject)', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].groupFetchAllParticipating = async () => ({
    'g1@g.us': { id: 'g1@g.us', subject: 'Study' },
    'g2@g.us': { id: 'g2@g.us', subject: '' },
  });
  assert.deepEqual(await a.listGroups(), [
    { id: 'g1@g.us', name: 'Study' },
    { id: 'g2@g.us', name: 'g2@g.us' },
  ]);
});

test('adapter: read-before-reply marks only addressed, non-self messages seen', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });

  makeSocket.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: '9@s.whatsapp.net', id: 'm1', fromMe: false }, message: { conversation: 'jarvis ping' } }, // addressed
      { key: { remoteJid: '9@s.whatsapp.net', id: 'm2', fromMe: true }, message: { conversation: 'jarvis ping' } }, // fromMe -> skip
      { key: { remoteJid: '9@s.whatsapp.net', id: 'm3' }, message: { conversation: 'hello' } }, // not addressed -> skip
    ],
  });
  await tick();

  assert.deepEqual(makeSocket.sockets[0].read.map((k) => k.id), ['m1']);
});

test('adapter: read receipts can be turned off via humanize', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket, humanize: { readReceipts: false } }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { remoteJid: '9@s.whatsapp.net', id: 'm1' }, message: { conversation: 'jarvis ping' } }],
  });
  await tick();
  assert.equal(makeSocket.sockets[0].read.length, 0);
});

test('adapter: marks the client online on connect by default; humanize.markOnline can turn it off', () => {
  const on = fakeSocketFactory();
  createWhatsAppAdapter(opts({ makeSocket: on })).start({ onMessage: async () => {} });
  assert.equal(on.sockets[0].config.markOnlineOnConnect, true); // online -> WhatsApp registers delivery/read

  const off = fakeSocketFactory();
  createWhatsAppAdapter(opts({ makeSocket: off, humanize: { markOnline: false } })).start({ onMessage: async () => {} });
  assert.equal(off.sockets[0].config.markOnlineOnConnect, false);
});

test('adapter: on connect, names an unnamed account then goes online (so receipts activate)', async () => {
  const makeSocket = fakeSocketFactory();
  createWhatsAppAdapter(opts({ makeSocket, humanize: { profileName: 'Jarvis' } })).start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  assert.equal(sock.named, 'Jarvis'); // account had no name -> set it (else WhatsApp ignores presence)
  assert.ok(sock.presence.some((p) => p.state === 'available')); // then broadcast online
});

test('adapter: leaves an existing profile name untouched, still goes online', async () => {
  const makeSocket = fakeSocketFactory();
  createWhatsAppAdapter(opts({ makeSocket, humanize: { profileName: 'Jarvis' } })).start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.user.name = 'Existing';
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  assert.equal(sock.named, undefined); // not renamed
  assert.ok(sock.presence.some((p) => p.state === 'available'));
});
