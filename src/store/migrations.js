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
    // Each step and its version bump run as one transaction, so a multi-statement migration that
    // fails (or a crash) part-way rolls back cleanly instead of leaving a half-applied schema that
    // would fail every boot. user_version is part of the db header, so it commits with the step.
    db.exec('BEGIN');
    try {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`); // version is a controlled integer
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = i + 1;
  }
  return version;
}
