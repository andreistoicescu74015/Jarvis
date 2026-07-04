/**
 * Keyword auto-replies - a small, deterministic rule engine. When an addressed message's command word
 * matches a rule's keyword, Jarvis posts that rule's reply: no AI, no tokens. Inspired by Home
 * Assistant's trigger -> action model, scoped to the one trigger that stays inside the addressed-only
 * pillar (a keyword on a message ADDRESSED to the bot - never ambient chat). Per-chat: a group's
 * auto-replies are its own. Pure over the KV store (ADR-0002) like access/scheduler, so rules survive
 * restarts.
 *
 * A rule is keyed by chat + keyword, so a keyword is unique per chat (adding it again overwrites the
 * reply). The reply supports a tiny WHITELISTED variable substitution (see `renderTemplate`); it is
 * never an arbitrary template language - no expressions, no code execution in a group-exposed bot.
 *
 * A rule: `{ chatId, keyword, reply, createdBy, createdAt }` stored under `${chatId}|${keyword}`.
 */
import { esc } from './format.js';

const MAX_REPLY_LEN = 1000; // characters in a rule's reply
const MAX_RULES = 100; // rules kept per chat
const KEYWORD_RE = /^[a-z0-9][a-z0-9_-]*$/; // a single lowercase token (like an alias name)
const SEP = '|'; // chat/keyword key separator: never in a jid or a keyword (which is [a-z0-9_-])

/**
 * Fill `{{name}}` placeholders from a WHITELIST of variables: a name present in `vars` is replaced with
 * its (escaped) value, any other placeholder is left literal. Deliberately NOT a template language -
 * there are no expressions and no code, so a rule can never do more than drop in a known value. Values
 * are run through `esc` so they cannot inject reply markup.
 *
 * @param {string} text
 * @param {Record<string, string>} [vars]
 * @returns {string}
 */
export function renderTemplate(text, vars = {}) {
  return String(text ?? '').replace(/\{\{(\w+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? esc(String(vars[name] ?? '')) : m,
  );
}

/**
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]
 */
export function createRules(store, { now = () => Date.now() } = {}) {
  const rules = store.scoped('rules'); // `${chatId}|${keyword}` -> { chatId, keyword, reply, createdBy, createdAt }
  const keyOf = (chatId, keyword) => `${chatId}${SEP}${keyword}`;
  const norm = (keyword) => String(keyword ?? '').trim().toLowerCase();

  /** This chat's rules, sorted by keyword. */
  const list = (chatId) =>
    rules
      .list()
      .map((e) => e.value)
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.keyword.localeCompare(b.keyword));

  /**
   * Define (upsert) a keyword auto-reply for a chat. Returns the saved keyword, or a reason it was rejected.
   *
   * @returns {{ ok: true, keyword: string } | { ok: false, reason: 'bad-keyword' | 'empty-reply' | 'too-long' | 'too-many', max?: number }}
   */
  function add({ chatId, createdBy = '', keyword, reply }) {
    const k = norm(keyword);
    const r = String(reply ?? '').trim();
    if (!KEYWORD_RE.test(k)) return { ok: false, reason: 'bad-keyword' };
    if (!r) return { ok: false, reason: 'empty-reply' };
    if (r.length > MAX_REPLY_LEN) return { ok: false, reason: 'too-long', max: MAX_REPLY_LEN };
    const key = keyOf(chatId, k);
    // A new keyword counts against the cap; overwriting an existing one does not.
    if (rules.get(key) == null && list(chatId).length >= MAX_RULES) return { ok: false, reason: 'too-many', max: MAX_RULES };
    rules.set(key, { chatId, keyword: k, reply: r, createdBy, createdAt: now() });
    return { ok: true, keyword: k };
  }

  /** The rule for (chatId, keyword), or undefined. Keyword match is case-insensitive. */
  function match(chatId, keyword) {
    return rules.get(keyOf(chatId, norm(keyword))) ?? undefined;
  }

  /** Remove a chat's rule by keyword. Returns true if one existed. */
  function remove(chatId, keyword) {
    const key = keyOf(chatId, norm(keyword));
    if (rules.get(key) == null) return false;
    rules.delete(key);
    return true;
  }

  /** Remove every rule of a chat (e.g. when the group is deactivated). Returns the count. */
  function clearChat(chatId) {
    const mine = list(chatId);
    for (const r of mine) rules.delete(keyOf(chatId, r.keyword));
    return mine.length;
  }

  return { add, match, list, remove, clearChat };
}
