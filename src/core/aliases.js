/**
 * Owner-defined command aliases: short names that expand to a full command line and run
 * deterministically (no AI, no tokens) before the AI translation branch. Pure over the KV store
 * (ADR-0002) like `access`/`scheduler` - one alias is one KV entry, so aliases survive restarts. They
 * are GLOBAL, not per-chat: an owner's shortcut works in any chat. The dispatcher reads them to expand
 * an addressed message; the `alias` command manages them.
 */

const MAX_TARGET_LEN = 500; // characters in an alias's command line
const MAX_ALIASES = 200; // aliases kept (owner-global)
// A single lowercase token: a letter or digit, then letters / digits / - / _. Letters are Unicode, so
// a shortcut can be a word in the language the chat actually speaks ("mancare", "mâncare") rather than
// only in ASCII. The separator characters this name is stored around are excluded by construction.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

/**
 * @param {import('../store/index.js').Store} store
 */
export function createAliases(store) {
  const aliases = store.scoped('aliases'); // name -> target command line (a string)

  return {
    /**
     * Define (upsert) an alias. Returns the saved name/target, or a reason it was rejected.
     *
     * @returns {{ ok: true, name: string, target: string } | { ok: false, reason: 'bad-name' | 'empty-target' | 'too-long' | 'too-many', max?: number }}
     */
    define(name, target) {
      const n = String(name ?? '').trim().toLowerCase();
      const t = String(target ?? '').trim();
      if (!NAME_RE.test(n)) return { ok: false, reason: 'bad-name' };
      if (!t) return { ok: false, reason: 'empty-target' };
      if (t.length > MAX_TARGET_LEN) return { ok: false, reason: 'too-long', max: MAX_TARGET_LEN };
      // A new name counts against the cap; overwriting an existing one does not.
      if (aliases.get(n) == null && aliases.list().length >= MAX_ALIASES) return { ok: false, reason: 'too-many', max: MAX_ALIASES };
      aliases.set(n, t);
      return { ok: true, name: n, target: t };
    },
    /** Remove an alias. Returns true if one existed. */
    remove(name) {
      const n = String(name ?? '').trim().toLowerCase();
      if (aliases.get(n) == null) return false;
      aliases.delete(n);
      return true;
    },
    /** The target command line for a name, or undefined. */
    get(name) {
      const v = aliases.get(String(name ?? '').trim().toLowerCase());
      return typeof v === 'string' ? v : undefined;
    },
    /** All aliases as `{ name, target }`, sorted by name. */
    list() {
      return aliases
        .list()
        .map((e) => ({ name: e.key, target: e.value }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
