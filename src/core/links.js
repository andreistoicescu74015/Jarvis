/**
 * Context links ("crossover"). Chats can be joined into a cluster that shares ONE
 * context: the same scoped store and the same membership. Any number of chats, any
 * mix of private/group, transitive (a cluster is one shared context).
 *
 * Linking MERGES the two sides' data and REFUSES on conflict (a key present on both
 * sides with a different value) - it never overwrites. Unlinking copies the shared
 * data out to the leaver, so nothing is lost. Pure over the KV store (ADR-0002); the
 * caller passes each chat's own namespace, so this module needs no knowledge of the
 * level/namespace format.
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ namespace?: string }} [opts]
 */
export function createLinks(store, { namespace = 'links' } = {}) {
  const map = store.scoped(namespace); // chatId -> clusterId; plus '#seq' -> counter
  const SEQ = '#seq';
  const clusterNs = (id) => `ctx:${id}`;

  const clusterId = (chatId) => (chatId === SEQ ? undefined : map.get(chatId));

  function nextId() {
    const n = Number(map.get(SEQ) ?? 0) + 1;
    map.set(SEQ, n);
    return `k${n}`;
  }

  const membersOf = (cluster) =>
    map.list().filter((e) => e.key !== SEQ && e.value === cluster).map((e) => e.key);

  /** Chats sharing this chat's cluster (including itself); just itself when unlinked. */
  function chats(chatId) {
    const c = clusterId(chatId);
    return c ? membersOf(c) : [chatId];
  }

  /** The store namespace a chat resolves to: the shared cluster ns if linked, else its own. */
  function nsFor(chatId, ownNs) {
    const c = clusterId(chatId);
    return c ? clusterNs(c) : ownNs;
  }

  const areLinked = (a, b) => {
    const ca = clusterId(a);
    return !!ca && ca === clusterId(b);
  };

  /** Keys present in both namespaces with a different value - a merge conflict. */
  function conflicts(nsA, nsB) {
    const a = new Map(store.kv.list(nsA).map((e) => [e.key, JSON.stringify(e.value)]));
    return store.kv
      .list(nsB)
      .filter((e) => a.has(e.key) && a.get(e.key) !== JSON.stringify(e.value))
      .map((e) => e.key);
  }

  /** Copy entries from one namespace into another without overwriting existing keys. */
  function fold(from, to) {
    for (const { key, value } of store.kv.list(from)) {
      if (!store.kv.has(to, key)) store.kv.set(to, key, value);
    }
  }

  /**
   * Join chat A (own ns `ownNsA`) and chat B (own ns `ownNsB`) into one cluster,
   * merging their data. Refuses on conflict; never overwrites.
   *
   * @returns {{ ok: true, cluster: string } | { ok: false, reason: string, conflicts?: string[] }}
   */
  function link(a, ownNsA, b, ownNsB) {
    if (!a || !b || a === b) return { ok: false, reason: 'same-chat' };
    const ca = clusterId(a);
    const cb = clusterId(b);
    if (ca && ca === cb) return { ok: false, reason: 'already-linked' };

    const nsA = ca ? clusterNs(ca) : ownNsA;
    const nsB = cb ? clusterNs(cb) : ownNsB;
    const clash = conflicts(nsA, nsB);
    if (clash.length) return { ok: false, reason: 'conflict', conflicts: clash };

    const target = ca || cb || nextId();
    const targetNs = clusterNs(target);
    // Members of each side are read up front (before any reassignment).
    const sides = [
      { members: ca ? membersOf(ca) : [a], ns: nsA, isTarget: target === ca },
      { members: cb ? membersOf(cb) : [b], ns: nsB, isTarget: target === cb },
    ];
    for (const side of sides) {
      if (!side.isTarget) fold(side.ns, targetNs); // bring this side's data into the shared ns
      for (const chat of side.members) map.set(chat, target);
    }
    return { ok: true, cluster: target };
  }

  /** Remove a chat from its cluster, copying the shared data out so nothing is lost. */
  function unlink(chatId, ownNs) {
    const c = clusterId(chatId);
    if (!c) return { ok: false, reason: 'not-linked' };
    for (const { key, value } of store.kv.list(clusterNs(c))) store.kv.set(ownNs, key, value);
    map.delete(chatId);
    return { ok: true };
  }

  return { nsFor, chats, areLinked, link, unlink };
}
