import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';
import { sameUser } from '../core/scope.js';
import { nullLogger } from '../core/log.js';

/**
 * Learn and persist LID <-> phone-number pairs so the same person can be matched
 * across both id spaces (v7 is LID-primary, but the owner is usually configured by
 * phone number). Pairs are learned lazily from message keys - in a group a v7 key
 * carries both `participant` (LID) and `participantPn` (PN) - and reused for owner
 * matching. Backed by the store; survives restarts. Identity is never used to grant
 * trust beyond owner/admin matching (crossover stays code-based).
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ namespace?: string, log?: import('../core/log.js').Logger }} [opts]
 */
export function createIdentityStore(store, { namespace = 'wa-identity', log = nullLogger } = {}) {
  const kv = store.scoped(namespace);
  const norm = (j) => (j ? jidNormalizedUser(j) || '' : '');

  /**
   * Persist a LID <-> PN pair (order-independent); ignores non LID/PN inputs. Refuses to overwrite a
   * known pairing on conflict (like the links engine): a LID maps to exactly one PN and vice-versa, so
   * a key that disagrees with what we already learned is stale or spoofed. We keep the first-learned
   * mapping and log, rather than let an arbitrary inbound message rewrite identity - which owner and
   * access-list matching depend on. Re-learning the same pair is a harmless no-op.
   */
  function learn(a, b) {
    const x = norm(a);
    const y = norm(b);
    let lid;
    let pn;
    if (isLidUser(x) && isPnUser(y)) [lid, pn] = [x, y];
    else if (isPnUser(x) && isLidUser(y)) [lid, pn] = [y, x];
    else return;
    const knownPn = kv.get(`lid:${lid}`);
    const knownLid = kv.get(`pn:${pn}`);
    if ((knownPn && knownPn !== pn) || (knownLid && knownLid !== lid)) {
      log.warn('wa-identity: refusing a conflicting LID<->PN pairing', { lid, pn, knownPn, knownLid });
      return;
    }
    kv.set(`lid:${lid}`, pn);
    kv.set(`pn:${pn}`, lid);
  }

  /** Learn from a WAMessage key, which in groups carries both id forms. */
  function learnFromKey(key) {
    if (!key) return;
    const cands = [key.participant, key.participantAlt, key.participantPn].filter(Boolean).map(norm);
    const lid = cands.find((j) => isLidUser(j));
    const pn = cands.find((j) => isPnUser(j));
    if (lid && pn) learn(lid, pn);
  }

  const pnForLid = (lid) => kv.get(`lid:${norm(lid)}`);
  const lidForPn = (pn) => kv.get(`pn:${norm(pn)}`);

  /** Map a jid toward its phone-number form when known; otherwise return it as-is. */
  function resolve(jid) {
    const j = norm(jid);
    return isLidUser(j) ? pnForLid(j) || j : j;
  }

  /** True if a and b are the same user, bridging LID <-> PN via learned pairs. */
  function same(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return sameUser(x, y) || sameUser(resolve(x), resolve(y));
  }

  return { learn, learnFromKey, pnForLid, lidForPn, resolve, same };
}
