import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';
import { createKv } from './kv.js';

/**
 * Open the store: connect `node:sqlite`, apply migrations, expose a namespaced KV.
 * All SQL lives under `src/store` so the engine stays swappable (ADR-0002). The
 * engine is synchronous - fine for a single-account bot.
 *
 * @param {{ path?: string }} [opts]  Database path; defaults to in-memory.
 * @returns {Store}
 *
 * @typedef {Object} Store
 * @property {ReturnType<typeof createKv>} kv                 Raw namespaced KV.
 * @property {(ns: string) => ScopedStore} scoped            A KV view bound to one namespace.
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
  migrate(db);
  const kv = createKv(db);

  return {
    kv,
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
