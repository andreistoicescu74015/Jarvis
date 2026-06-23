import { nullLogger } from '../core/log.js';

/**
 * HTTP client for the Instagram sidecar (a Python `instagrapi` microservice; see `insta-sidecar/`).
 * It is the ONLY thing that speaks the sidecar's wire shapes - everything it returns is a clean
 * value-object, so the bridge and the `ig` command never see raw Instagram/instagrapi primitives
 * (the "translate, not pass-through" rule). Deliberately thin and best-effort: any failure - no
 * sidecar configured, a network error, a timeout, a non-ok response - resolves to a falsy/empty
 * value, so the deterministic bot is never blocked when the Instagram leg is down (mirrors the AI
 * client).
 *
 * Returns null when no `baseUrl` is configured - the Instagram bridge is then simply off and the
 * caller stays WhatsApp-only. `fetchImpl` is injectable so tests stay offline.
 *
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, log?: import('../core/log.js').Logger, timeoutMs?: number }} [opts]
 * @returns {{ send: (m: object) => Promise<boolean>, threads: () => Promise<object[]>, challenge: (value: string) => Promise<boolean> } | null}
 */
export function createSidecarClient({ baseUrl = '', token = '', fetchImpl = fetch, log = nullLogger, timeoutMs = 8000 } = {}) {
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

  return {
    /**
     * Send a DM. The sidecar resolves the target in order: threadId, then userId, then username.
     * @returns {Promise<boolean>} delivered?
     */
    async send({ username, threadId, userId, text } = {}) {
      const data = await call('/send', { username, thread_id: threadId, user_id: userId, text });
      return !!data?.ok;
    },

    /** Recent DM threads as clean value-objects. Empty array on any failure. */
    async threads() {
      const data = await call('/threads', {});
      const list = Array.isArray(data?.threads) ? data.threads : [];
      return list.map((t) => ({
        username: String(t?.username ?? ''),
        name: String(t?.name ?? t?.username ?? ''),
        unread: !!t?.unread,
        lastText: String(t?.last_text ?? ''),
      }));
    },

    /** Submit a login-challenge code (2FA / checkpoint) the bridge asked the owner about. @returns accepted? */
    async challenge(value) {
      const data = await call('/challenge', { code: String(value ?? '') });
      return !!data?.ok;
    },
  };
}
