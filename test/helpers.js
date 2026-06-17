import { toPlain } from '../src/core/format.js';

/**
 * In-memory adapter for tests: inject inbound messages with `receive(...)` and
 * inspect outbound replies via `sent`. Like the real adapters, it renders the
 * reply's neutral markup - here to plain text - so `sent[].text` is what a user sees.
 *
 * @returns {import('../src/core/app.js').Adapter & {
 *   sent: { chatId: string, text: string }[],
 *   receive: (partial?: object) => Promise<void>,
 * }}
 */
export function createTestAdapter() {
  const sent = [];
  let onMessage = async () => {};

  return {
    sent,
    start(handlers) {
      onMessage = handlers.onMessage;
    },
    send(chatId, message) {
      sent.push({ chatId, text: toPlain(typeof message === 'string' ? message : message.text) });
    },
    stop() {},
    // Simulate one inbound message; resolves after the handler has run.
    async receive(partial = {}) {
      await onMessage({
        kind: 'message',
        text: '',
        chatId: 'test-chat',
        sender: 'tester',
        level: 'private',
        fromMe: false,
        ...partial,
      });
    },
  };
}
