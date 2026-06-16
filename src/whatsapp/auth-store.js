import { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } from 'baileys';
import { socketLogger } from './socket-logger.js';

/**
 * Persist Baileys auth state in our SQLite store - NEVER the file-based demo
 * `useMultiFileAuthState`. Creds and Signal keys are serialized with Baileys'
 * `BufferJSON` (so Buffers survive) and kept as values in a dedicated KV
 * namespace, reusing the store engine + migrations with no new schema. The v7
 * key types (`lid-mapping`, `device-list`, `tctoken`, ...) round-trip as-is.
 *
 * @param {import('../store/index.js').Store} store  A store (typically its own db file).
 * @param {{ namespace?: string, logger?: any }} [opts]
 * @returns {{ state: { creds: any, keys: any }, saveCreds: () => void, clear: () => void }}
 */
export function createSqliteAuthState(store, { namespace = 'wa-auth', logger = socketLogger() } = {}) {
  const kv = store.scoped(namespace);

  const write = (name, value) => kv.set(name, JSON.stringify(value, BufferJSON.replacer));
  const read = (name) => {
    const raw = kv.get(name);
    return raw == null ? undefined : JSON.parse(/** @type {string} */ (raw), BufferJSON.reviver);
  };

  const creds = read('creds') ?? initAuthCreds();

  /** Raw signal key store: Baileys reads/writes keys by `{type}-{id}`. */
  const keys = {
    /** @param {string} type @param {string[]} ids */
    get(type, ids) {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const id of ids) {
        let value = read(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[id] = value;
      }
      return out;
    },
    /** @param {Record<string, Record<string, unknown>>} data */
    set(data) {
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          const name = `${type}-${id}`;
          if (value) write(name, value);
          else kv.delete(name);
        }
      }
    },
  };

  return {
    state: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
    saveCreds() {
      write('creds', creds);
    },
    clear() {
      for (const { key } of kv.list()) kv.delete(key);
    },
  };
}
