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

/** A logger that records warn messages, so tests can assert what surfaces vs stays quiet. */
const captureLog = () => {
  const warns = [];
  return { warns, log: { info() {}, debug() {}, warn: (m) => warns.push(m), error() {} } };
};

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
    messages: [{ key: { remoteJid: 'G@g.us', participant: '111@lid', participantAlt: '40712@s.whatsapp.net' }, message: { conversation: 'hello' } }],
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

test('adapter: a redelivered message (same key.id) is handled only once', async () => {
  const makeSocket = fakeSocketFactory();
  const received = [];
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async (m) => { received.push(m); } });

  const dup = { key: { remoteJid: '9@s.whatsapp.net', id: 'dup1' }, message: { conversation: 'jarvis ping' } };
  makeSocket.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [dup] });
  await tick();
  makeSocket.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [dup] }); // redelivered
  await tick();

  assert.equal(received.length, 1); // the duplicate key.id is dropped
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

test('adapter: a logout before ever connecting reads as a rejected pairing, not a device unlink', async () => {
  const makeSocket = fakeSocketFactory();
  const { log, warns } = captureLog();
  createWhatsAppAdapter(opts({ makeSocket, log })).start({ onMessage: async () => {} });
  // 401 with no prior 'open' = WhatsApp rejecting the just-paired session (companion-pairing flakiness)
  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await tick();
  assert.ok(warns.some((m) => /pairing rejected/i.test(m)));
  assert.ok(!warns.some((m) => /device unlinked/i.test(m)));
});

test('adapter: a logout after a working connection reads as a device unlink', async () => {
  const makeSocket = fakeSocketFactory();
  const { log, warns } = captureLog();
  createWhatsAppAdapter(opts({ makeSocket, log })).start({ onMessage: async () => {} });
  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'open' }); // connected at least once
  await tick();
  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await tick();
  assert.ok(warns.some((m) => /device unlinked/i.test(m)));
  assert.ok(!warns.some((m) => /pairing rejected/i.test(m)));
});

test('adapter: a routine reconnect close (428) stays out of the warn log', async () => {
  const makeSocket = fakeSocketFactory();
  const { log, warns } = captureLog();
  createWhatsAppAdapter(opts({ makeSocket, log })).start({ onMessage: async () => {} });
  makeSocket.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  assert.ok(!warns.some((m) => /connection closed/.test(m))); // routine churn is debug, not warn
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

test('adapter: reports connection state for the liveness heartbeat (true on open, false on close)', async () => {
  const makeSocket = fakeSocketFactory();
  const states = [];
  const a = createWhatsAppAdapter(opts({ makeSocket, onConnectionState: (c) => states.push(c) }));
  a.start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];

  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  assert.deepEqual(states, [true, false]);
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

test('adapter: listGroups maps participating groups (id when no subject; community wiring)', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].groupFetchAllParticipating = async () => ({
    'g1@g.us': { id: 'g1@g.us', subject: 'Study' },
    'g2@g.us': { id: 'g2@g.us', subject: '' },
    'c@g.us': { id: 'c@g.us', subject: 'Class', isCommunity: true }, // a community's announcement group
    's@g.us': { id: 's@g.us', subject: 'Sub', linkedParent: 'c@g.us' }, // a sub-group of that community
  });
  assert.deepEqual(await a.listGroups(), [
    { id: 'g1@g.us', name: 'Study', community: undefined, isCommunity: false },
    { id: 'g2@g.us', name: 'g2@g.us', community: undefined, isCommunity: false },
    { id: 'c@g.us', name: 'Class', community: 'c@g.us', isCommunity: true },
    { id: 's@g.us', name: 'Sub', community: 'c@g.us', isCommunity: false },
  ]);
});

test('adapter: community.info shapes metadata + linked groups and caches the read', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  const s = makeSocket.sockets[0];
  let metaCalls = 0;
  s.communityMetadata = async (jid) => { metaCalls += 1; return { id: jid, subject: 'Anul 2', desc: 'Info hub', size: 501 }; };
  s.communityFetchLinkedGroups = async () => ({
    communityJid: 'c@g.us',
    isCommunity: true,
    linkedGroups: [
      { id: 'g1@g.us', subject: 'General', size: 412 },
      { id: 'g2@g.us', subject: 'Lab', size: 88 },
    ],
  });
  assert.deepEqual(await a.community.info('c@g.us'), {
    id: 'c@g.us',
    name: 'Anul 2',
    description: 'Info hub',
    subGroups: [
      { id: 'g1@g.us', name: 'General', size: 412 },
      { id: 'g2@g.us', name: 'Lab', size: 88 },
    ],
    reach: 501,
  });
  assert.deepEqual(await a.community.groups('c@g.us'), [
    { id: 'g1@g.us', name: 'General', size: 412 },
    { id: 'g2@g.us', name: 'Lab', size: 88 },
  ]);
  assert.equal(metaCalls, 1); // the second read is served from the TTL cache
});

test('adapter: community.info is best-effort - a fetch error yields undefined, never throws', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  const s = makeSocket.sockets[0];
  s.communityMetadata = async () => { throw new Error('not a community'); };
  s.communityFetchLinkedGroups = async () => ({ linkedGroups: [] });
  assert.equal(await a.community.info('x@g.us'), undefined);
});

test('adapter: community.info does not cache an empty read - it retries until the backend recovers', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  const s = makeSocket.sockets[0];
  s.communityFetchLinkedGroups = async () => ({ linkedGroups: [] });
  let attempt = 0;
  s.communityMetadata = async (jid) => (++attempt === 1 ? {} : { id: jid, subject: 'Anul 2', size: 7 }); // first: id-less
  assert.equal(await a.community.info('c@g.us'), undefined); // empty read -> NOT cached
  assert.deepEqual(await a.community.info('c@g.us'), { id: 'c@g.us', name: 'Anul 2', subGroups: [], reach: 7 }); // retried -> real value
});

test('adapter: community.all shallow-lists the participating communities', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].communityFetchAllParticipating = async () => ({
    'c@g.us': { id: 'c@g.us', subject: 'Anul 2', size: 501 },
    'd@g.us': { id: 'd@g.us', subject: '', participants: [{}, {}] },
  });
  assert.deepEqual(await a.community.all(), [
    { id: 'c@g.us', name: 'Anul 2', reach: 501 },
    { id: 'd@g.us', name: 'd@g.us', reach: 2 },
  ]);
});

test('adapter: listGroups includes member counts when WhatsApp reports them', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].groupFetchAllParticipating = async () => ({
    'a@g.us': { id: 'a@g.us', subject: 'A', size: 88 }, // size reported directly
    'b@g.us': { id: 'b@g.us', subject: 'B', participants: [{}, {}, {}] }, // counted from participants
    'c@g.us': { id: 'c@g.us', subject: 'C' }, // no size info -> field omitted
  });
  assert.deepEqual(await a.listGroups(), [
    { id: 'a@g.us', name: 'A', community: undefined, isCommunity: false, size: 88 },
    { id: 'b@g.us', name: 'B', community: undefined, isCommunity: false, size: 3 },
    { id: 'c@g.us', name: 'C', community: undefined, isCommunity: false },
  ]);
});

test('adapter: communityOf resolves a chat parent community from group metadata', async () => {
  const makeSocket = fakeSocketFactory();
  const a = createWhatsAppAdapter(opts({ makeSocket }));
  a.start({ onMessage: async () => {} });
  makeSocket.sockets[0].groupMetadata = async (jid) => {
    if (jid === 's@g.us') return { id: jid, linkedParent: 'c@g.us', participants: [] }; // a sub-group
    if (jid === 'c@g.us') return { id: jid, isCommunity: true, participants: [] }; // announcement group
    return { id: jid, participants: [] }; // a plain group
  };
  assert.equal(await a.communityOf('s@g.us'), 'c@g.us'); // sub-group -> its parent community
  assert.equal(await a.communityOf('c@g.us'), 'c@g.us'); // announcement group -> itself
  assert.equal(await a.communityOf('plain@g.us'), undefined); // a plain group -> none
  assert.equal(await a.communityOf('1@s.whatsapp.net'), undefined); // not a group at all
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

test('adapter: a failing profile-name update still goes online (app-state not synced after pairing)', async () => {
  const makeSocket = fakeSocketFactory();
  createWhatsAppAdapter(opts({ makeSocket, humanize: { profileName: 'Jarvis' } })).start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.updateProfileName = async () => { throw new Error('App state key not present!'); };
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  // The name failure is isolated: the bot must still broadcast 'available' so receipts can activate.
  assert.ok(sock.presence.some((p) => p.state === 'available'));
});

test('adapter: the expected fresh-pairing profile-name failure stays out of the warn log', async () => {
  const makeSocket = fakeSocketFactory();
  const { log, warns } = captureLog();
  createWhatsAppAdapter(opts({ makeSocket, log, humanize: { profileName: 'Jarvis' } })).start({ onMessage: async () => {} });
  const sock = makeSocket.sockets[0];
  sock.updateProfileName = async () => { throw new Error('App state key not present!'); };
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  assert.ok(!warns.some((m) => /profile name/.test(m))); // the app-state-key case is debug, not warn
});
