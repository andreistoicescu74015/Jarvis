import { sameUser } from './scope.js';

/**
 * Resolve the bot owner (ADR-0007): a configured id (from env), or - if none is
 * set - the first user to invoke an owner-only command becomes the owner,
 * ephemerally, until restart. Identity comparison is injectable so a platform can
 * bridge its id forms (e.g. the WhatsApp identity store maps LID <-> phone).
 *
 * Eligibility for a first-claim (a private chat, the command passing its scope) is
 * decided by the dispatcher; this resolver just records the decision via `claim`.
 *
 * @param {{ owner?: string, match?: (a: string, b: string) => boolean }} [opts]
 * @returns {{ isOwner: (sender: string) => boolean, claim: (sender: string) => void, resign: () => void, readonly current: string, readonly fromEnv: boolean }}
 */
export function createOwnerResolver({ owner = '', match = sameUser } = {}) {
  const fromEnv = !!owner;
  let current = owner ? String(owner) : '';

  return {
    isOwner: (sender) => !!current && !!sender && match(sender, current),
    /** Record the owner (via `jarvis owner claim`); the command checks the slot is free first. */
    claim(sender) {
      if (sender) current = String(sender);
    },
    /** Relinquish ownership (the `owner` command restricts this to the current owner). */
    resign() {
      current = '';
    },
    get current() {
      return current;
    },
    get fromEnv() {
      return fromEnv;
    },
  };
}
