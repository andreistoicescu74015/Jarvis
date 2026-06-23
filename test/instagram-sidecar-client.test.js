import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramClient } from '../src/instagram/sidecar-client.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

/** A fetch double that records each call and returns whatever `responder` yields. */
function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

test('ig client: null when no baseUrl is configured (bridge off)', () => {
  assert.equal(createInstagramClient({}), null);
  assert.equal(createInstagramClient({ baseUrl: '' }), null);
});

test('ig client: send strips a leading @, trims the URL slash, and reports ok', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createInstagramClient({ baseUrl: 'http://side/', token: 'sec', fetchImpl });
  const r = await client.send('@Alice', 'hi there');
  assert.deepEqual(r, { ok: true, reason: undefined, detail: undefined });
  assert.equal(calls[0].url, 'http://side/send');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sec');
  assert.deepEqual(calls[0].body, { username: 'Alice', text: 'hi there' });
});

test('ig client: send refuses empty args without calling the sidecar', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.send('', 'hi'), { ok: false, reason: 'bad_args' });
  assert.deepEqual(await client.send('alice', '   '), { ok: false, reason: 'bad_args' });
  assert.equal(calls.length, 0);
});

test('ig client: send surfaces the sidecar reason (e.g. a pending challenge)', async () => {
  const { fetchImpl } = recordingFetch(() => okJson({ ok: false, status: 'challenge_required', detail: 'code sent' }));
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.send('alice', 'hi'), { ok: false, reason: 'challenge_required', detail: 'code sent' });
});

test('ig client: send reports offline when the sidecar is unreachable (best-effort)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.send('alice', 'hi'), { ok: false, reason: 'offline' });
});

test('ig client: code posts the value and reports acceptance', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.equal(await client.code('123456'), true);
  assert.equal(calls[0].url, 'http://side/challenge');
  assert.deepEqual(calls[0].body, { code: '123456' });
});

test('ig client: status normalizes the sidecar shape', async () => {
  const { fetchImpl } = recordingFetch(() => okJson({ state: 'logged_in', account: 'me', sent_last_hour: 3 }));
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.status(), { ok: true, state: 'logged_in', account: 'me', detail: undefined, sentLastHour: 3 });
});

test('ig client: status reports offline on failure', async () => {
  const { fetchImpl } = recordingFetch(() => fail());
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.status(), { ok: false, state: 'offline' });
});

test('ig client: omits the auth header when no token is set', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createInstagramClient({ baseUrl: 'http://side', fetchImpl });
  await client.send('a', 'x');
  assert.equal(calls[0].init.headers.authorization, undefined);
});
