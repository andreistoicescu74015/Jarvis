import { createInterface } from 'node:readline';

/**
 * CLI adapter: each stdin line becomes an inbound message; replies go to stdout.
 * A dependency-free dev/test harness implementing the Adapter contract. Inbound
 * lines are handled one at a time (serialized) so replies stay ordered.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 * @returns {import('../core/app.js').Adapter}
 */
export function createCliAdapter({ input = process.stdin, output = process.stdout } = {}) {
  /** @type {import('node:readline').Interface | undefined} */
  let rl;

  return {
    // Resolves when the input stream closes (EOF / Ctrl-D), after draining the queue.
    start({ onMessage }) {
      rl = createInterface({ input, output, terminal: false });
      let queue = Promise.resolve();

      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        queue = queue
          .then(() =>
            onMessage({
              kind: 'message',
              text,
              chatId: 'cli',
              sender: 'cli-user',
              level: 'private',
              fromMe: false,
              raw: line,
            }),
          )
          .catch((err) => output.write(`error: ${err?.message ?? err}\n`));
      });

      return new Promise((resolve) => {
        rl.on('close', () => queue.then(resolve, resolve));
      });
    },

    send(chatId, message) {
      output.write(`${typeof message === 'string' ? message : message.text}\n`);
    },

    stop() {
      rl?.close();
    },
  };
}
