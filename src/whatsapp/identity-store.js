import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';
import { sameUser } from '../core/scope.js';
import { nullLogger } from '../core/log.js';

/**
 * Learn and persist LID <-> phone-number pairs so the same person can be matched
 * across both id spaces (v7 is LID-primary, but the owner is usually configured by
 * phone number). Pairs are learned lazily from message keys - in a group a v7 key
 * carries both `participant` (the addressing-mode JID, usually the LID) and
 * `participantAlt` (its alternate form, the phone number); the legacy `participantPn`
 * is accepted defensively. Reused for owner matching. Backed by the store; survives
 * restarts. Identity is never used to grant trust beyond owner/admin matching
 * (crossover stays code-based).
 *
 * Mappings SELF-HEAL: a single conflicting key is refused (it may be stale or spoofed),
 * but a legitimate change - someone moving their account to a new phone number -
 * re-appears on every message they send, so a conflicting pair observed consistently
 * enough (see `noteConflict`) replaces the stored one. `forget` is the owner's manual
 * escape hatch for the same problem (`jarvis whoami forget`).
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ namespace?: string, log?: import('../core/log.js').Logger, now?: () => number }} [opts]
 */
export function createIdentityStore(store, { namespace = 'wa-identity', log = nullLogger, now = () => Date.now() } = {}) {
  const kv = store.scoped(namespace);
  const norm = (j) => (j ? jidNormalizedUser(j) || '' : '');
  // Self-heal bar: the SAME conflicting pair must be seen this many times, spread over MORE THAN ONE
  // server-local day, before it replaces a stored mapping. A one-off spoofed key can never cross it;
  // a real number change (which recurs on every message) heals within a couple of days.
  const HEAL_MIN_SIGHTINGS = 3;
  const dayStr = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /**
   * Persist a LID <-> PN pair (order-independent); ignores non LID/PN inputs. A pairing that
   * disagrees with what we already learned is NOT applied directly - a LID maps to exactly one PN and
   * vice-versa, and owner/access-list matching depend on it - but it is COUNTED (`noteConflict`), so
   * a persistently recurring conflict eventually heals the mapping while a one-off never does.
   * Re-learning the same pair is a harmless no-op.
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
      noteConflict(lid, pn, { knownPn, knownLid });
      return;
    }
    kv.set(`lid:${lid}`, pn);
    kv.set(`pn:${pn}`, lid);
  }

  // One conflicting observation of the candidate pair (lid, pn). Counted per exact pair (a different
  // candidate starts its own counter), with first/last day-of-sighting so persistence across days is
  // required. Crossing the bar heals: both sides' stale mappings are dropped and the new pair is
  // adopted (logged at warn - identity changes must be auditable).
  function noteConflict(lid, pn, { knownPn, knownLid }) {
    const key = `conflict:${lid}|${pn}`;
    const today = dayStr(now());
    const cur = kv.get(key);
    const rec = cur
      ? { count: cur.count + 1, firstDay: cur.firstDay, lastDay: today }
      : { count: 1, firstDay: today, lastDay: today };
    if (rec.count >= HEAL_MIN_SIGHTINGS && rec.lastDay !== rec.firstDay) {
      const oldPn = kv.get(`lid:${lid}`);
      if (typeof oldPn === 'string' && oldPn !== pn) kv.delete(`pn:${oldPn}`);
      const oldLid = kv.get(`pn:${pn}`);
      if (typeof oldLid === 'string' && oldLid !== lid) kv.delete(`lid:${oldLid}`);
      kv.set(`lid:${lid}`, pn);
      kv.set(`pn:${pn}`, lid);
      kv.delete(key);
      log.warn('wa-identity: remapped a pairing after repeated consistent conflicts', {
        lid,
        pn,
        sightings: rec.count,
        knownPn,
        knownLid,
      });
      return;
    }
    kv.set(key, rec);
    log.warn('wa-identity: refusing a conflicting LID<->PN pairing', { lid, pn, knownPn, knownLid, sightings: rec.count });
  }

  /**
   * Owner escape hatch (`jarvis whoami forget`): drop everything learned about one person - the
   * mapping in both directions plus any pending conflict counters naming them - so the next message
   * they send re-learns the pair fresh. Accepts either id form. Returns true if anything was removed.
   */
  function forget(jid) {
    const j = norm(jid);
    if (!j) return false;
    let removed = false;
    const drop = (key) => {
      if (kv.delete(key)) removed = true;
    };
    let counterpart;
    if (isLidUser(j)) {
      counterpart = kv.get(`lid:${j}`);
      drop(`lid:${j}`);
      if (typeof counterpart === 'string') drop(`pn:${counterpart}`);
    } else if (isPnUser(j)) {
      counterpart = kv.get(`pn:${j}`);
      drop(`pn:${j}`);
      if (typeof counterpart === 'string') drop(`lid:${counterpart}`);
    } else {
      return false;
    }
    // Sweep pending conflict counters naming this person - by EITHER id form (a counter is keyed by
    // the candidate pair, so it may carry the person's lid alongside a pn we never stored).
    const ids = typeof counterpart === 'string' ? [j, counterpart] : [j];
    for (const { key } of kv.list()) {
      if (key.startsWith('conflict:') && ids.some((id) => key.includes(id))) drop(key);
    }
    return removed;
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

  return { learn, learnFromKey, pnForLid, lidForPn, resolve, same, forget };
}
