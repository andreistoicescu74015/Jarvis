import { b, i, code, esc } from '../core/format.js';
import { nullLogger } from '../core/log.js';

/**
 * The Instagram <-> WhatsApp bridge core. PURE of any transport: `ingest(event)` takes a normalized
 * event the sidecar pushed (an inbound DM, or a login challenge) and relays it into the OWNER's
 * WhatsApp via `send`; `capability` is the owner-only `ctx.instagram` the `ig` command consumes to
 * read threads / send a reply / answer a challenge. All Instagram I/O goes through the injected
 * `client` (the sidecar HTTP client), so this module is fully unit-testable with a fake client.
 *
 * This is a PERSONAL relay: everything is delivered to ONE person, the owner. With no owner
 * configured (OWNER_JID) there is no relay target, so an inbound event is dropped and logged - the
 * `ig` command is owner-only anyway, so the whole feature presumes an owner.
 *
 * A small thread map (one KV namespace) remembers `username -> { threadId, userId, name }` from
 * inbound DMs, so a reply by username resolves to the right thread without another lookup.
 *
 * @param {{
 *   store: import('../store/index.js').Store,
 *   send: (target: string, text: string) => unknown,
 *   owner?: string,
 *   client: { send: Function, threads: Function, challenge: Function },
 *   prefix?: string,
 *   log?: import('../core/log.js').Logger,
 * }} opts
 * @returns {{ ingest: (event: object) => Promise<boolean>, capability: object }}
 */
export function createBridge({ store, send, owner = '', client, prefix = 'jarvis', log = nullLogger }) {
  const threads = store.scoped('ig-threads'); // username(lowercase) -> { threadId, userId, name }
  const handleOf = (person) => String(person ?? '').trim().replace(/^@/, '').toLowerCase();

  function remember(ev) {
    const handle = handleOf(ev?.username);
    if (!handle) return;
    threads.set(handle, { threadId: ev.threadId ?? null, userId: ev.userId ?? null, name: ev.name || ev.username });
  }

  /** Relay one sidecar-pushed event into the owner's WhatsApp. @returns {Promise<boolean>} relayed? */
  async function ingest(event) {
    if (!owner || typeof send !== 'function') {
      log.warn('ig: inbound dropped - no owner relay target (set OWNER_JID)');
      return false;
    }
    const type = event?.type;
    if (type === 'challenge') {
      await send(owner, [
        b('Instagram needs you to confirm a login.'),
        `${esc(event.detail || 'A verification code was sent to the account.')} Reply ${code(`${prefix} ig code <value>`)}.`,
      ].join('\n'));
      return true;
    }
    if (type === 'message') {
      remember(event);
      const who = esc(event.name || event.username || 'someone');
      const handle = handleOf(event.username) || 'them';
      await send(owner, [
        `${b(`[IG] ${who}`)}: ${esc(event.text ?? '')}`,
        i('reply: ') + code(`${prefix} ig ${handle} <message>`),
      ].join('\n'));
      return true;
    }
    log.debug('ig: ignored an unknown inbound event', { type });
    return false;
  }

  // The owner-only `ctx.instagram` capability. Personal (not chat-scoped), so it is the same object
  // for every command run - no per-message binding needed, unlike the chat-bound capabilities.
  const capability = {
    /** Send a DM to an Instagram username (resolved against remembered threads). @returns delivered? */
    async send(person, text) {
      const handle = handleOf(person);
      const known = threads.get(handle) || {};
      return client.send({ username: handle, threadId: known.threadId, userId: known.userId, text });
    },
    /** Recent DM threads (clean value-objects from the sidecar client). */
    threads: () => client.threads(),
    /** Submit a login-challenge code (2FA / checkpoint). */
    code: (value) => client.challenge(value),
  };

  return { ingest, capability };
}
