import { sameUser } from './scope.js';

/**
 * Resolve the bot owner (ADR-0007): a configured id (from env), or - if none is
 * set - the first user to invoke an owner-only command becomes the owner,
 * ephemerally, until restart. Identity comparison is injectable so a platform can
 * bridge its id forms (e.g. the WhatsApp identity store maps LID <-> phone).
 *
 * @param {{ owner?: string, match?: (a: string, b: string) => boolean }} [opts]
 * @returns {{ isOwner: (sender: string) => boolean, claimIfUnset: (sender: string) => boolean, readonly current: string, readonly fromEnv: boolean }}
 */
export function createOwnerResolver({ owner = '', match = sameUser } = {}) {
  const fromEnv = !!owner;
  let current = owner ? String(owner) : '';

  const isOwner = (sender) => !!current && !!sender && match(sender, current);

  return {
    isOwner,
    /** First-claimer: if no owner is set yet, the sender claims it. Returns whether it is now the owner. */
    claimIfUnset(sender) {
      if (!current && sender) current = String(sender);
      return isOwner(sender);
    },
    get current() {
      return current;
    },
    get fromEnv() {
      return fromEnv;
    },
  };
}
