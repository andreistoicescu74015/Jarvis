import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSidecarClient } from '../src/instagram/sidecar-client.js';

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

test('sidecar client: null when no baseUrl is configured (bridge simply off)', () => {
  assert.equal(createSidecarClient({}), null);
  assert.equal(createSidecarClient({ baseUrl: '' }), null);
});

test('sidecar client: send posts the resolve fields and reports delivery', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createSidecarClient({ baseUrl: 'http://side/', token: 'sec', fetchImpl });
  const ok = await client.send({ username: 'alice', threadId: 't1', userId: 'u1', text: 'hi' });
  assert.equal(ok, true);
  assert.equal(calls[0].url, 'http://side/send'); // a trailing slash on baseUrl is trimmed
  assert.equal(calls[0].init.headers.authorization, 'Bearer sec');
  assert.deepEqual(calls[0].body, { username: 'alice', thread_id: 't1', user_id: 'u1', text: 'hi' });
});

test('sidecar client: send returns false on a non-ok response', async () => {
  const { fetchImpl } = recordingFetch(() => fail(502));
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  assert.equal(await client.send({ username: 'a', text: 'x' }), false);
});

test('sidecar client: send returns false when fetch throws (offline; best-effort)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  assert.equal(await client.send({ username: 'a', text: 'x' }), false);
});

test('sidecar client: threads normalizes raw shapes into clean value-objects', async () => {
  const { fetchImpl } = recordingFetch(() =>
    okJson({ threads: [{ username: 'alice', name: 'Alice P', unread: true, last_text: 'yo' }, { username: 'bob' }] }),
  );
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.threads(), [
    { username: 'alice', name: 'Alice P', unread: true, lastText: 'yo' },
    { username: 'bob', name: 'bob', unread: false, lastText: '' },
  ]);
});

test('sidecar client: threads is empty on failure', async () => {
  const { fetchImpl } = recordingFetch(() => fail());
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  assert.deepEqual(await client.threads(), []);
});

test('sidecar client: challenge posts the code and reports acceptance', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  assert.equal(await client.challenge('123456'), true);
  assert.equal(calls[0].url, 'http://side/challenge');
  assert.deepEqual(calls[0].body, { code: '123456' });
});

test('sidecar client: omits the auth header when no token is set', async () => {
  const { fetchImpl, calls } = recordingFetch(() => okJson({ ok: true }));
  const client = createSidecarClient({ baseUrl: 'http://side', fetchImpl });
  await client.send({ username: 'a', text: 'x' });
  assert.equal(calls[0].init.headers.authorization, undefined);
});
