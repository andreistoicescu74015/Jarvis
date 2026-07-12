/**
 * Per-group activation (ADR-0008): the owner authorizes Jarvis to act in a group. A group
 * or community is inactive until activated; while inactive the bot stays silent there. An
 * activation is one KV entry (chatId -> who/when), so it survives restarts. Pure over the
 * store like links / scheduler / access - no SQL, unit-testable. Private chats never need
 * activation; this only tracks group/community ids.
 *
 * @param {import('../store/index.js').Store} store
 * @param {{ now?: () => number }} [opts]
 */
export function createActivation(store, { now = () => Date.now() } = {}) {
  const kv = store.scoped('activation'); // chatId -> { by, at }

  return {
    /** Whether a chat has been activated. */
    isActive: (chatId) => kv.has(chatId),

    /**
     * Whether a chat is EFFECTIVELY active: its own activation entry, or a live community umbrella
     * (`communityId` is the chat's parent community, when it has one). This is THE rule every gate
     * shares - the dispatcher's inbound gate, proactive delivery, and link handshakes all call this
     * one predicate instead of re-deriving it.
     */
    isActiveVia: (chatId, communityId) => kv.has(chatId) || (!!communityId && kv.has(communityId)),

    /**
     * Activate a chat (idempotent), recording who activated it and when.
     * @returns {boolean} true if it was newly activated, false if already active.
     */
    activate(chatId, by = '') {
      if (kv.has(chatId)) return false;
      kv.set(chatId, { by, at: now() });
      return true;
    },

    /**
     * Deactivate a chat.
     * @returns {boolean} true if it had been active, false otherwise.
     */
    deactivate: (chatId) => kv.delete(chatId),

    /** Every active chat id. */
    list: () => kv.list().map((e) => e.key),
  };
}
