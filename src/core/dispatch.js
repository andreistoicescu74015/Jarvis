import { parse } from './parse.js';

/**
 * The capabilities a command receives. Grows over later issues (store, ai, ...).
 *
 * @typedef {Object} Ctx
 * @property {string} command                              Invoked command name.
 * @property {string[]} args                               Positional arguments.
 * @property {string} rest                                 Raw argument string.
 * @property {string} text                                 Full message text.
 * @property {import('./registry.js').Command[]} commands  Registered commands (for help/man).
 * @property {(text: string) => void} reply                Queue a line to send back.
 */

/**
 * Build the message handler that parses `<prefix> <command>` and dispatches to a
 * registered command. A command's error is caught, so one bad command never
 * crashes the bot. Returns a `handle(msg)` suitable for `createApp`.
 *
 * @param {import('./registry.js').Registry} registry
 * @param {{ prefix?: string }} [opts]
 * @returns {(msg: { text: string }) => Promise<string | undefined>}
 */
export function createDispatcher(registry, { prefix = 'jarvis' } = {}) {
  return async function handle(msg) {
    const parsed = parse(msg.text, prefix);
    if (!parsed) return undefined; // not addressed to the bot

    const { command, args, rest } = parsed;
    if (!command) return `Try "${prefix} help".`;

    const cmd = registry.get(command);
    if (!cmd) return `Unknown command "${command}". Try "${prefix} help".`;

    const replies = [];
    const ctx = {
      command,
      args,
      rest,
      text: msg.text,
      commands: registry.all(),
      reply: (text) => replies.push(text),
    };

    try {
      const result = await cmd.run(ctx);
      if (result != null && result !== '') replies.push(String(result));
    } catch (err) {
      return `Command "${command}" failed: ${err?.message ?? err}`;
    }

    return replies.length ? replies.join('\n') : undefined;
  };
}
