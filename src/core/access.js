import { sameUser } from './scope.js';

/**
 * The owner-managed manual access layer (ADR-0006), on top of a command's built-in
 * `scope`. The owner can put a target - a command, or the whole bot (target `*`) -
 * into one of three modes per context: `public` (default), `whitelist` (only listed
 * pass), or `blacklist` (all but listed pass). Both member lists are persisted with
 * one marked `active`, so toggling visibility (`enable`/`disable`) never loses a list.
 *
 * The owner is never subject to this layer; that bypass is enforced by the dispatcher,
 * not here. Matching is identity-aware via the injected `match` (bridges LID <-> phone);
 * the literal `*` as a member means "everyone". State lives in one KV namespace, one
 * record per `(target, context)`, so the same store also answers "every rule" for the
 * overview. No SQL here - the engine stays swappable (ADR-0002).
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ match?: (a: string, b: string) => boolean, namespace?: string }} [opts]
 */
export function createAccessPolicy(store, { match = sameUser, namespace = 'access' } = {}) {
  const kv = store.scoped(namespace);
  const SEP = '|'; // safe: command names and JIDs never contain it
  const keyOf = (target, context) => `${target}${SEP}${context}`;
  const blank = () => ({ active: 'public', whitelist: [], blacklist: [] });

  function read(target, context) {
    const rec = kv.get(keyOf(target, context));
    return rec ? { ...blank(), ...rec } : blank();
  }

  function write(target, context, rec) {
    // Drop fully-default records so the store - and the overview - stay clean.
    if (rec.active === 'public' && rec.whitelist.length === 0 && rec.blacklist.length === 0) {
      kv.delete(keyOf(target, context));
    } else {
      kv.set(keyOf(target, context), rec);
    }
  }

  const member = (m) => m === '*'; // wildcard member = everyone
  const hits = (user, members) => members.some((m) => member(m) || match(user, m));
  const samePerson = (a, b) => a === b || (a !== '*' && b !== '*' && match(a, b));

  /**
   * Whether `user` satisfies the active rule for `target`, checked against the given
   * context AND the global `*` context (both must pass). The owner bypass happens in
   * the dispatcher; this assumes a non-owner.
   */
  function passes(target, context, user) {
    const contexts = context === '*' ? ['*'] : [context, '*'];
    for (const cid of contexts) {
      const rec = read(target, cid);
      if (rec.active === 'public') continue;
      const hit = hits(user, rec[rec.active]);
      if (rec.active === 'whitelist' && !hit) return false;
      if (rec.active === 'blacklist' && hit) return false;
    }
    return true;
  }

  // --- mutators: the dispatcher exposes these to the owner-only list commands ---

  /** Add a person to a list's members. Does NOT change the active mode (manual control). */
  function add(list, target, context, user) {
    const rec = read(target, context);
    if (!rec[list].some((m) => samePerson(m, user))) rec[list] = [...rec[list], user];
    write(target, context, rec);
  }

  /** Remove a person from a list's members (identity-aware). */
  function remove(list, target, context, user) {
    const rec = read(target, context);
    rec[list] = rec[list].filter((m) => !samePerson(m, user));
    write(target, context, rec);
  }

  /** Make a list the active mode (members untouched; an empty whitelist = owner-only). */
  function enable(list, target, context) {
    const rec = read(target, context);
    rec.active = list;
    write(target, context, rec);
  }

  /** Turn off restrictions (back to public) while keeping both member lists. */
  function disable(target, context) {
    const rec = read(target, context);
    rec.active = 'public';
    write(target, context, rec);
  }

  /** Empty a list's members and reopen the target if that list was active. */
  function clear(list, target, context) {
    const rec = read(target, context);
    rec[list] = [];
    if (rec.active === list) rec.active = 'public';
    write(target, context, rec);
  }

  /** The stored record for one target/context (for `show`). */
  function get(target, context) {
    return read(target, context);
  }

  /** Every stored rule, decoded - for the overview. */
  function all() {
    return kv.list().map(({ key, value }) => {
      const i = key.indexOf(SEP);
      return { target: key.slice(0, i), context: key.slice(i + 1), ...value };
    });
  }

  return { passes, add, remove, enable, disable, clear, get, all };
}
