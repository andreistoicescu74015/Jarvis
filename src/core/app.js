/**
 * Communication boundary + app loop.
 *
 * An Adapter normalizes a platform (WhatsApp, CLI, ...) to one shape: it
 * delivers inbound messages and sends outbound replies. The core only talks to
 * this contract - it never imports a platform SDK.
 *
 * @typedef {Object} InboundMessage
 * @property {'message'} kind
 * @property {string} text                          Message text.
 * @property {string} chatId                        Conversation id (reply target).
 * @property {string} sender                        Sender id.
 * @property {'private'|'group'|'community'} level  Conversation level.
 * @property {boolean} fromMe                       True if sent by the bot's own account.
 * @property {boolean} [isAdmin]                    Sender is an admin of this chat (groups).
 * @property {boolean} [addressed]                  Platform already decided the bot is addressed without a prefix (e.g. @mention); the text is a bare command.
 * @property {string[]} [self]                      The bot's own id forms, so a command can avoid acting on the bot.
 * @property {unknown} [raw]                        Platform-native payload (escape hatch).
 *
 * @typedef {string | { text: string }} OutboundMessage
 *
 * @typedef {Object} Adapter
 * @property {(handlers: { onMessage: (msg: InboundMessage) => unknown }) => (void | Promise<void>)} start
 * @property {(chatId: string, message: OutboundMessage) => (void | Promise<void>)} send
 * @property {() => (void | Promise<void>)} stop
 *
 * @typedef {Object} App
 * @property {() => (void | Promise<void>)} start
 * @property {() => (void | Promise<void>)} stop
 */

/**
 * Wire an adapter to a message handler. For each inbound message that is not
 * from the bot itself, `handle` is called; a non-empty return value is sent
 * back to the originating chat.
 *
 * @param {Adapter} adapter
 * @param {{ handle: (msg: InboundMessage) => unknown }} options
 * @returns {App}
 */
export function createApp(adapter, { handle } = {}) {
  if (typeof handle !== 'function') {
    throw new TypeError('createApp(adapter, { handle }): handle must be a function');
  }

  const onMessage = async (msg) => {
    if (msg.fromMe) return; // never react to our own messages
    const reply = await handle(msg);
    if (reply != null && reply !== '') {
      await adapter.send(msg.chatId, reply);
    }
  };

  return {
    start: () => adapter.start({ onMessage }),
    stop: () => adapter.stop(),
  };
}
