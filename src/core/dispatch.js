import { parse } from './parse.js';
import { checkScope } from './scope.js';
import { createOwnerResolver } from './owner.js';
import { nullLogger } from './log.js';

/**
 * The capabilities a command receives. Grows over later issues (store, ai, ...).
 *
 * @typedef {Object} Ctx
 * @property {string} command                              Invoked command name.
 * @property {string[]} args                               Positional arguments.
 * @property {string} rest                                 Raw argument string.
 * @property {string} text                                 Full message text.
 * @property {'private'|'group'|'community'} level         Conversation level.
 * @property {string} sender                               Sender id.
 * @property {boolean} isOwner                             Sender is the bot owner.
 * @property {boolean} isAdmin                             Sender is an admin here (groups).
 * @property {import('./registry.js').Command[]} commands  Registered commands (for help/man).
 * @property {(text: string) => void} reply                Queue a line to send back.
 * @property {import('../store/index.js').ScopedStore} [store] Per-conversation scoped KV (when configured).
 * @property {import('./log.js').Logger} log               Structured logger (never posts to chat).
 * @property {{ shutdown?: () => void, restart?: () => void, logout?: () => void }} [lifecycle] Process lifecycle controls (owner commands; injected per platform).
 */

/**
 * Build the message handler that parses `<prefix> <command>`, enforces the
 * command's scope, then dispatches. A command's error is caught, so one bad
 * command never crashes the bot. Returns a `handle(msg)` for `createApp`.
 *
 * @param {import('./registry.js').Registry} registry
 * @param {{ prefix?: string, owner?: string, store?: import('../store/index.js').Store, log?: import('./log.js').Logger, match?: (a: string, b: string) => boolean, lifecycle?: object }} [opts]
 * @returns {(msg: import('./app.js').InboundMessage) => Promise<string | undefined>}
 */
export function createDispatcher(registry, { prefix = 'jarvis', owner = '', store, log = nullLogger, match, lifecycle } = {}) {
  const ownerResolver = createOwnerResolver({ owner, match });
  return async function handle(msg) {
    const parsed = parse(msg.text, prefix, { addressed: msg.addressed });
    if (!parsed) return undefined; // not addressed to the bot

    const { command, args, rest } = parsed;
    if (!command) return `Try "${prefix} help".`;

    const cmd = registry.get(command);
    if (!cmd) return `Unknown command "${command}". Try "${prefix} help".`;

    const level = msg.level ?? 'private';
    const sender = msg.sender ?? '';
    const isAdmin = msg.isAdmin ?? false;
    // Owner-scoped commands trigger first-claimer when no owner is configured yet
    // (ADR-0007): the first such invoker becomes the ephemeral owner.
    const isOwner =
      cmd.scope?.owner && !ownerResolver.current
        ? ownerResolver.claimIfUnset(sender)
        : ownerResolver.isOwner(sender);

    const scoped = checkScope(cmd.scope, { level, isAdmin, isOwner });
    if (!scoped.ok) return `Not allowed: ${scoped.reason}.`;

    const replies = [];
    const ctx = {
      command,
      args,
      rest,
      text: msg.text,
      level,
      sender,
      isOwner,
      isAdmin,
      commands: registry.all(),
      reply: (text) => replies.push(text),
      store: store ? store.scoped(`${level}:${msg.chatId ?? 'cli'}`) : undefined,
      log,
      lifecycle,
    };

    try {
      const result = await cmd.run(ctx);
      if (result != null && result !== '') replies.push(String(result));
    } catch (err) {
      // A command failure is logged internally and never surfaced in chat: it
      // would be noise and could leak internals. Any partial replies are dropped.
      log.error(`command "${command}" failed`, {
        error: err?.message ?? String(err),
        sender,
        level,
      });
      return undefined;
    }

    return replies.length ? replies.join('\n') : undefined;
  };
}
