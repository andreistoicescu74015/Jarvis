import { sameUser } from './scope.js';

/**
 * Resolve the bot owner (ADR-0007): a configured id (from env), or - if none is
 * set - whoever claimed the slot with `jarvis owner claim`. A claim is PERSISTED
 * (via the injected `meta` KV) so it survives restarts - otherwise every routine
 * restart would reopen the claim window to any stranger who can DM the bot.
 * `OWNER_JID` stays authoritative: the moment it is set, a previously claimed
 * owner is silently invalidated (the persisted claim is dropped). Identity
 * comparison is injectable so a platform can bridge its id forms (e.g. the
 * WhatsApp identity store maps LID <-> phone).
 *
 * Eligibility for a first-claim (a private chat, the command passing its scope) is
 * decided by the dispatcher; this resolver just records the decision via `claim`.
 *
 * @param {{ owner?: string, match?: (a: string, b: string) => boolean, meta?: { get: (k: string) => unknown, set: (k: string, v: unknown) => void, delete: (k: string) => boolean } }} [opts]
 *   `meta` is a scoped KV for the persisted claim (no meta -> the claim is ephemeral, as before).
 * @returns {{ isOwner: (sender: string) => boolean, claim: (sender: string) => void, resign: () => void, readonly current: string, readonly fromEnv: boolean }}
 */
export function createOwnerResolver({ owner = '', match = sameUser, meta } = {}) {
  const fromEnv = !!owner;
  let current = owner ? String(owner) : '';
  if (meta) {
    if (fromEnv) {
      // OWNER_JID wins: any previously claimed owner is invalidated silently - the stale claim is
      // deleted, not left around to resurface if the env var is ever removed.
      meta.delete('claimed');
    } else {
      const claimed = meta.get('claimed');
      if (typeof claimed === 'string' && claimed) current = claimed; // a claim survives restarts
    }
  }

  return {
    isOwner: (sender) => !!current && !!sender && match(sender, current),
    /** Record the owner (via `jarvis owner claim`); the command checks the slot is free first. */
    claim(sender) {
      if (!sender) return;
      current = String(sender);
      meta?.set('claimed', current); // persisted; cleared by resign, or overridden by OWNER_JID
    },
    /** Relinquish ownership (the `owner` command restricts this to the current owner). */
    resign() {
      current = '';
      meta?.delete('claimed');
    },
    get current() {
      return current;
    },
    get fromEnv() {
      return fromEnv;
    },
  };
}
