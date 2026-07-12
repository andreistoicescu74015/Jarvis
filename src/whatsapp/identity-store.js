import { isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from 'baileys';
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
  // Self-heal bar: the SAME conflicting pair must be seen this many times, spread over at least a
  // full day of ELAPSED time (epoch math, not calendar-day labels - a burst straddling midnight
  // must not count as "two days"), before it replaces a stored mapping. A short burst can never
  // cross it; a real number change (which recurs on every message) heals within a couple of days.
  // Sightings must also stay FRESH: a counter untouched longer than the window starts over, so a
  // few stale one-offs months apart can never accumulate into a heal, and old counters are swept.
  const HEAL_MIN_SIGHTINGS = 3;
  const HEAL_MIN_SPREAD_MS = 24 * 60 * 60 * 1000; // sightings must span at least this much real time
  const HEAL_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a counter idle this long resets (and is swept)

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
  // candidate starts its own counter) as `{ count, first, last }` in epoch ms, so the bar measures
  // ELAPSED time. Crossing the bar heals: both sides' stale mappings are dropped and the new pair is
  // adopted (logged at warn - identity changes must be auditable).
  function noteConflict(lid, pn, { knownPn, knownLid }) {
    const key = `conflict:${lid}|${pn}`;
    const at = now();
    const cur = kv.get(key);
    // Fresh-window check; also resets a legacy day-string record (no `first`) rather than guessing.
    const stale = !cur || !Number.isFinite(cur.first) || at - cur.last > HEAL_FRESH_WINDOW_MS;
    const rec = stale
      ? { count: 1, first: at, last: at }
      : { count: Math.min(cur.count + 1, HEAL_MIN_SIGHTINGS), first: cur.first, last: at };
    if (rec.count >= HEAL_MIN_SIGHTINGS && rec.last - rec.first >= HEAL_MIN_SPREAD_MS) {
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
    // Persist the counter, but throttle the no-op rewrites: once the count is at the bar, only the
    // recency stamp changes, and refreshing it more than hourly buys nothing - `learn` runs on every
    // inbound message, and a chatty sender with a stale pairing must not turn into a write per message.
    if (stale || rec.count < HEAL_MIN_SIGHTINGS || at - cur.last > 60 * 60 * 1000) {
      // A brand-new conflict is rare - use the moment to sweep counters idle past the fresh window,
      // so one-off pairs that never recur cannot accumulate in the namespace forever.
      if (!cur) {
        for (const { key: k, value: v } of kv.list()) {
          if (k.startsWith('conflict:') && k !== key && !(Number.isFinite(v?.last) && at - v.last <= HEAL_FRESH_WINDOW_MS)) kv.delete(k);
        }
      }
      kv.set(key, rec);
    }
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
    // the candidate pair, so it may carry the person's lid alongside a pn we never stored). The key
    // is parsed and compared by EQUALITY: a substring match would let one person's jid (a suffix of
    // another's number, e.g. a +1 number embedding a full foreign number) delete someone else's
    // in-progress heal counter and report a false success.
    const ids = new Set(typeof counterpart === 'string' ? [j, counterpart] : [j]);
    for (const { key } of kv.list()) {
      if (!key.startsWith('conflict:')) continue;
      const [lidPart, pnPart] = key.slice('conflict:'.length).split('|');
      if (ids.has(lidPart) || ids.has(pnPart)) drop(key);
    }
    return removed;
  }

  /**
   * Learn from a WAMessage key. In groups both id forms ride on the participant fields; in a DM the
   * chat jid IS the sender and v7 carries the alternate form in `remoteJidAlt` - harvest those too,
   * so DM-only traffic also teaches the LID<->PN bridge. Without it, an owner whose DM flips
   * addressing mode (LID migration) would stop matching with no group message to re-teach the pair.
   */
  function learnFromKey(key) {
    if (!key) return;
    const cands = [key.participant, key.participantAlt, key.participantPn];
    if (key.remoteJid && !isJidGroup(key.remoteJid)) cands.push(key.remoteJid, key.remoteJidAlt);
    const norms = cands.filter(Boolean).map(norm);
    const lid = norms.find((j) => isLidUser(j));
    const pn = norms.find((j) => isPnUser(j));
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
