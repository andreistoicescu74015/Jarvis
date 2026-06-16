/**
 * Ordered, idempotent schema migrations, tracked with SQLite's `PRAGMA user_version`
 * (ADR-0004). Each entry is one forward step; the runner applies only the steps the
 * database has not seen yet, so calling `migrate` again is a no-op.
 */

/** @type {Array<(db: import('node:sqlite').DatabaseSync) => void>} */
export const MIGRATIONS = [
  // v1 - namespaced key-value store.
  (db) => {
    db.exec(`
      CREATE TABLE kv (
        ns    TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (ns, key)
      );
    `);
  },
];

/**
 * Apply every pending migration in order. Returns the resulting schema version.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i](db);
    version = i + 1;
    db.exec(`PRAGMA user_version = ${version}`); // version is a controlled integer
  }
  return version;
}
