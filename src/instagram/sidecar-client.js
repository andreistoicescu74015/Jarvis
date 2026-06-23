import { nullLogger } from '../core/log.js';

/**
 * Client for the Instagram sidecar (a Python `instagrapi` microservice; see `insta-sidecar/`). This
 * IS the owner-only `ctx.instagram` capability: an OUTBOUND-only bridge - send a DM, submit a login
 * challenge code, read the bridge status. It is the only thing that speaks the sidecar's wire shapes,
 * so the `ig` command sees clean value-objects ("translate, not pass-through"). Thin and best-effort:
 * any failure resolves to a clear, non-throwing result, so the deterministic bot is never blocked
 * when the Instagram leg is down (mirrors the AI client).
 *
 * Returns null when no `baseUrl` is configured - the bridge is then simply off and the caller stays
 * WhatsApp-only. `fetchImpl` is injectable so tests stay offline.
 *
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, log?: import('../core/log.js').Logger, timeoutMs?: number }} [opts]
 * @returns {{ send: (person: string, text: string) => Promise<{ ok: boolean, reason?: string, detail?: string }>, code: (value: string) => Promise<boolean>, status: () => Promise<object> } | null}
 */
export function createInstagramClient({ baseUrl = '', token = '', fetchImpl = fetch, log = nullLogger, timeoutMs = 8000 } = {}) {
  if (!baseUrl) return null;
  const root = baseUrl.replace(/\/+$/, '');

  async function call(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn('ig: sidecar request failed', { path, status: res.status });
        return null;
      }
      return await res.json();
    } catch (err) {
      log.warn('ig: sidecar request error', { path, error: err?.message ?? String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const handleOf = (person) => String(person ?? '').trim().replace(/^@/, '');

  return {
    /**
     * Send a DM to an Instagram username. Resolves to { ok, reason?, detail? } - never throws.
     * `reason` carries the sidecar's status on failure (challenge_required / not_logged_in /
     * rate_capped / unknown_user / ...), so the command can tell the owner exactly what happened.
     */
    async send(person, text) {
      const username = handleOf(person);
      if (!username || !String(text ?? '').trim()) return { ok: false, reason: 'bad_args' };
      const data = await call('/send', { username, text });
      if (!data) return { ok: false, reason: 'offline' };
      return { ok: !!data.ok, reason: data.status, detail: data.detail };
    },

    /** Submit a login-challenge code (2FA / checkpoint) the owner read from `jarvis ig`. @returns accepted? */
    async code(value) {
      const data = await call('/challenge', { code: String(value ?? '') });
      return !!data?.ok;
    },

    /** Bridge status: { ok, state, account?, detail?, sentLastHour? }. `ok:false` / state 'offline' when unreachable. */
    async status() {
      const data = await call('/status', {});
      if (!data) return { ok: false, state: 'offline' };
      return { ok: true, state: data.state, account: data.account, detail: data.detail, sentLastHour: data.sent_last_hour };
    },

    /** Send to an existing thread (a GROUP or a 1:1) by its thread id. Resolves to { ok, reason?, detail? }. */
    async sendThread(threadId, text) {
      if (!threadId || !String(text ?? '').trim()) return { ok: false, reason: 'bad_args' };
      const data = await call('/send', { thread_id: threadId, text });
      if (!data) return { ok: false, reason: 'offline' };
      return { ok: !!data.ok, reason: data.status, detail: data.detail };
    },

    /** Recent DM + group threads (so the owner can pick one). { ok, threads: [{ threadId, title, isGroup, count }] }. */
    async threads() {
      const data = await call('/threads', {});
      if (!data || !data.ok) return { ok: false, threads: [] };
      const list = Array.isArray(data.threads) ? data.threads : [];
      return {
        ok: true,
        threads: list.map((t) => ({ threadId: String(t.thread_id ?? ''), title: String(t.title ?? ''), isGroup: !!t.is_group, count: Number(t.count ?? 0) })),
      };
    },

    /** Read the last `amount` messages of a conversation (by `username` 1:1, or by `threadId`).
     *  { ok, title, messages: [{ fromMe, username, text }] } (oldest -> newest); reason on failure. */
    async messages({ username, threadId, amount = 10 } = {}) {
      const data = await call('/messages', { username, thread_id: threadId, amount });
      if (!data || !data.ok) return { ok: false, reason: data?.status, messages: [] };
      const list = Array.isArray(data.messages) ? data.messages : [];
      return {
        ok: true,
        title: String(data.title ?? ''),
        messages: list.map((m) => ({ fromMe: !!m.from_me, username: String(m.username ?? ''), text: String(m.text ?? '') })),
      };
    },
  };
}
