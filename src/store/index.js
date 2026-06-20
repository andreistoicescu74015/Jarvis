import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';
import { createKv } from './kv.js';

/**
 * Open the store: connect `node:sqlite`, apply migrations, expose a namespaced KV and a
 * transaction helper. All SQL lives under `src/store` so the engine stays swappable
 * (ADR-0002). The engine is synchronous - fine for a single-account bot.
 *
 * @param {{ path?: string }} [opts]  Database path; defaults to in-memory.
 * @returns {Store}
 *
 * @typedef {Object} Store
 * @property {ReturnType<typeof createKv>} kv                 Raw namespaced KV.
 * @property {<T>(fn: () => T) => T} transaction             Run fn atomically (all-or-nothing); re-entrant.
 * @property {(ns: string) => ScopedStore} scoped            A KV view bound to one namespace.
 * @property {(ns: string) => number} clearNamespace        Delete every entry in a namespace.
 * @property {() => void} close
 *
 * @typedef {Object} ScopedStore
 * @property {(key: string) => unknown} get
 * @property {(key: string, value: unknown) => void} set
 * @property {(key: string) => boolean} has
 * @property {(key: string) => boolean} delete
 * @property {() => { key: string, value: unknown }[]} list
 */
export function createStore({ path = ':memory:' } = {}) {
  // node:sqlite opens the file but will not create its parent directory, so a
  // fresh checkout (where `data/` is gitignored) would fail on first run.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  // WAL is markedly more crash-resilient for a long-running unattended writer (a crash mid-write
  // can't corrupt the main db file), and busy_timeout makes a momentary lock wait instead of
  // throwing SQLITE_BUSY. WAL is a harmless no-op on an in-memory db (tests stay on the default).
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  const kv = createKv(db);

  // Atomic, all-or-nothing writes. Re-entrant: a nested call joins the open transaction (so a
  // compound op that calls another transactional op stays one unit), and a throw rolls back the
  // whole thing - so a crash or a thrown error can never leave a multi-write half-applied.
  let depth = 0;
  function transaction(fn) {
    if (depth > 0) return fn(); // already inside a transaction: join it
    depth += 1;
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth -= 1;
    }
  }

  return {
    kv,
    transaction,
    clearNamespace: (ns) => kv.clear(ns),
    scoped(ns) {
      return {
        get: (key) => kv.get(ns, key),
        set: (key, value) => kv.set(ns, key, value),
        has: (key) => kv.has(ns, key),
        delete: (key) => kv.delete(ns, key),
        list: () => kv.list(ns),
      };
    },
    close() {
      db.close();
    },
  };
}
