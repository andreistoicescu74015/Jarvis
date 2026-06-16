/**
 * Namespaced key-value repository over the sqlite engine. Keys live under a
 * namespace (`ns`); values are stored as JSON. Commands never see SQL - they reach
 * this through `ctx.store` (ADR-0002).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createKv(db) {
  const selStmt = db.prepare('SELECT value FROM kv WHERE ns = ? AND key = ?');
  const setStmt = db.prepare(
    'INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value',
  );
  const delStmt = db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?');
  const listStmt = db.prepare('SELECT key, value FROM kv WHERE ns = ? ORDER BY key');

  return {
    /** @returns {unknown} the value, or undefined if absent. */
    get(ns, key) {
      const row = selStmt.get(ns, key);
      return row ? JSON.parse(row.value) : undefined;
    },
    set(ns, key, value) {
      setStmt.run(ns, key, JSON.stringify(value));
    },
    has(ns, key) {
      return selStmt.get(ns, key) !== undefined;
    },
    /** @returns {boolean} true if a row was removed. */
    delete(ns, key) {
      return delStmt.run(ns, key).changes > 0;
    },
    /** @returns {{ key: string, value: unknown }[]} all entries in the namespace. */
    list(ns) {
      return listStmt.all(ns).map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
    },
  };
}
