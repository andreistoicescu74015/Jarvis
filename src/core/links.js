/**
 * Context links ("crossover") - an OVERLAY model. Linking two active groups joins them into a shared
 * OVERLAY context that COVERS each group's own data without merging it: while linked, a group reads
 * and writes the shared overlay and its own data is set aside, untouched, returning the instant it
 * unlinks. Links form a graph (any number of groups, transitive); the shared context is the connected
 * component. A redundant link inside one component just adds an edge - insurance, so one group leaving
 * cannot split the rest. Two groups that are each already in a (different) component cannot be linked;
 * unlink one side first.
 *
 * Splitting is deliberately simple: if removing a group would disconnect the component, the WHOLE
 * overlay dissolves and every member reverts to its own data (the shared data is discarded). Because
 * the overlay never holds a group's own data (it only covers it), no merge or copy-out is ever needed.
 *
 * Pure over the KV store (ADR-0002). `isActivated` (both groups must be active to link), the clock,
 * the code generator, and `clearNamespace` (to drop a dissolved overlay's data) are injected.
 *
 * @param {import('../store/index.js').Store} store
 */
export function createLinks(store, {
  isActivated = () => true,
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  genCode,
  clearNamespace = () => {},
} = {}) {
  const edges = store.scoped('link-edges'); // edgeId "a|b" (sorted) -> { a, b }; a group JID never contains '|'
  const member = store.scoped('link-member'); // chatId -> overlayId
  const seq = store.scoped('link-seq'); // 'n' -> the overlay-id counter (its own ns: cannot collide with a chatId)
  const codes = store.scoped('link-codes'); // one-time link codes: code -> { from, at }
  const makeCode = genCode ?? (() => Math.random().toString(36).slice(2, 8).toUpperCase());
  const overlayNs = (id) => `ctx:${id}`;
  const edgeId = (a, b) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

  function nextOverlay() {
    const n = Number(seq.get('n') ?? 0) + 1;
    seq.set('n', n);
    return `k${n}`;
  }

  const overlayOf = (g) => member.get(g);
  const membersOf = (overlay) => member.list().filter((e) => e.value === overlay).map((e) => e.key);
  const allEdges = () => edges.list().map((e) => e.value);
  const neighbours = (g) => allEdges().filter((e) => e.a === g || e.b === g).map((e) => (e.a === g ? e.b : e.a));

  /** Every group reachable from `start` via the current edges (its connected component, incl. itself). */
  function reachable(start) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const n of neighbours(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return seen;
  }

  /** The store namespace a chat resolves to: the shared overlay if linked, else its own. */
  function nsFor(chatId, ownNs) {
    const o = overlayOf(chatId);
    return o ? overlayNs(o) : ownNs;
  }

  /** Chats sharing this chat's overlay (including itself); just itself when unlinked. */
  function chats(chatId) {
    const o = overlayOf(chatId);
    return o ? membersOf(o) : [chatId];
  }

  /** Create a one-time code (TTL) this group shares to invite another group to link. */
  function propose(from) {
    const code = makeCode();
    codes.set(code, { from, at: now() });
    return code;
  }

  /**
   * Redeem a code from group `by`. Both groups must be ACTIVE and not already in different overlays.
   * Joining a solo group to an overlay just covers it; two solo groups create a fresh overlay; a
   * redundant edge inside one overlay is allowed (connectivity insurance).
   *
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function accept(code, by) {
    // Atomic: code consumption + the membership/edge writes commit together (re-entrant), so a crash
    // can't burn the code without linking, or link without consuming the code.
    return store.transaction(() => {
      const c = String(code ?? '').trim().toUpperCase();
      const rec = codes.get(c);
      if (!rec) return { ok: false, reason: 'bad-code' };
      if (now() - rec.at > ttlMs) {
        codes.delete(c);
        return { ok: false, reason: 'expired' };
      }
      codes.delete(c); // one-time: a valid code is spent by this attempt, whatever the outcome
      const from = rec.from;
      if (from === by) return { ok: false, reason: 'same-chat' };
      if (!isActivated(by) || !isActivated(from)) return { ok: false, reason: 'inactive' };
      const oBy = overlayOf(by);
      const oFrom = overlayOf(from);
      if (oBy && oFrom && oBy === oFrom) {
        edges.set(edgeId(by, from), { a: by, b: from }); // already one overlay: a redundant edge is insurance
        return { ok: true, redundant: true };
      }
      if (oBy && oFrom) return { ok: false, reason: 'both-linked' }; // two different overlays - unlink one first
      const overlay = oBy || oFrom || nextOverlay();
      if (!oBy) member.set(by, overlay);
      if (!oFrom) member.set(from, overlay);
      edges.set(edgeId(by, from), { a: by, b: from });
      return { ok: true };
    });
  }

  /** Remove a group from its overlay; if that disconnects the rest, the whole overlay dissolves. */
  function unlink(chatId) {
    // Atomic: the edge/membership removal and any dissolve commit together.
    return store.transaction(() => {
      const o = overlayOf(chatId);
      if (!o) return { ok: false, reason: 'not-linked' };
      dropEdgesOf(chatId);
      member.delete(chatId); // the leaver reverts to its own data (which the overlay only covered)
      const rest = membersOf(o);
      if (rest.length <= 1 || !connected(rest)) dissolve(o, rest);
      return { ok: true };
    });
  }

  function dropEdgesOf(g) {
    for (const e of allEdges()) if (e.a === g || e.b === g) edges.delete(edgeId(e.a, e.b));
  }

  /** Whether every group in `members` is one connected component under the current edges. */
  function connected(members) {
    if (members.length <= 1) return true;
    const comp = reachable(members[0]);
    return members.every((m) => comp.has(m));
  }

  /** Dissolve an overlay: every member reverts to its own data and the shared data is discarded. */
  function dissolve(overlay, members) {
    for (const m of members) {
      dropEdgesOf(m);
      member.delete(m);
    }
    clearNamespace(overlayNs(overlay));
  }

  return { nsFor, chats, propose, accept, unlink };
}
