/**
 * In-memory adapter for tests: inject inbound messages with `receive(...)` and
 * inspect outbound replies via `sent`.
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
      sent.push({ chatId, text: typeof message === 'string' ? message : message.text });
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
