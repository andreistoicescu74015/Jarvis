import { randomInt } from 'node:crypto';

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
  const makeCode = genCode ?? cryptoCode;
  const overlayNs = (id) => `ctx:${id}`;
  const edgeId = (a, b) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

  // The default code generator: CRYPTO-random (a code is a capability - whoever redeems it joins the
  // overlay - so it must not come from a predictable PRNG) over an unambiguous uppercase alphabet
  // (no 0/O or 1/I/L), because codes get read aloud and retyped between groups. 6 chars over 31
  // symbols ~ 8.9e8 combinations for a one-time code that lives 10 minutes.
  function cryptoCode() {
    const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  }

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

  /** Every overlay as a list of its member groups (for display). Solo groups are not listed. */
  function clusters() {
    const byOverlay = {};
    for (const { key, value } of member.list()) (byOverlay[value] ??= []).push(key);
    return Object.values(byOverlay);
  }

  /**
   * Create a one-time code (TTL) this group shares to invite another group to link. `fromCommunity`
   * (the proposer's parent community, when it has one) rides along on the code, so redemption can
   * honor the community-umbrella activation for the proposing side too.
   */
  function propose(from, fromCommunity) {
    // Sweep codes past their redemption TTL before issuing a new one: a code is otherwise only deleted
    // when someone redeems it, so proposed-but-never-redeemed codes would accumulate forever. Atomic
    // with the new code's write (re-entrant), mirroring accept/unlink.
    return store.transaction(() => {
      for (const { key, value } of codes.list()) {
        if (now() - value.at > ttlMs) codes.delete(key);
      }
      // Never hand out a code that is still outstanding: a collision would silently replace the
      // earlier code, stranding the group that shared it. Bounded retry - with crypto codes a repeat
      // is astronomically unlikely; the bound only guards a degenerate injected generator.
      let code = makeCode();
      for (let i = 0; i < 8 && codes.get(code) !== undefined; i++) code = makeCode();
      codes.set(code, { from, ...(fromCommunity ? { fromCommunity } : {}), at: now() });
      return code;
    });
  }

  /**
   * Redeem a code from group `by`. Both groups must be ACTIVE - individually, or via their community
   * umbrella (`byCommunity` is the redeemer's parent community; the proposer's rides on the code) -
   * and not already in different overlays. Joining a solo group to an overlay just covers it; two
   * solo groups create a fresh overlay; a redundant edge inside one overlay is allowed (insurance).
   *
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function accept(code, by, byCommunity) {
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
      // Active = an own activation entry OR a live community umbrella (checked at redemption time,
      // so a community deactivated after the code was issued no longer authorizes its groups).
      const activeVia = (id, community) => isActivated(id) || (community && isActivated(community));
      if (!activeVia(by, byCommunity) || !activeVia(from, rec.fromCommunity)) return { ok: false, reason: 'inactive' };
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

  return { nsFor, chats, clusters, propose, accept, unlink };
}
