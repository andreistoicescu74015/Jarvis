import { parse } from './parse.js';
import { checkScope, sameUser } from './scope.js';
import { createOwnerResolver } from './owner.js';
import { createAccessPolicy } from './access.js';
import { createLinks } from './links.js';
import { nullLogger } from './log.js';

/**
 * The capabilities a command receives. Grows over later issues (ai, scheduler, ...).
 *
 * @typedef {Object} Ctx
 * @property {string} command                              Invoked command name.
 * @property {string[]} args                               Positional arguments.
 * @property {string} rest                                 Raw argument string.
 * @property {string} text                                 Full message text.
 * @property {'private'|'group'|'community'} level         Conversation level.
 * @property {string} sender                               Sender id.
 * @property {string} chatId                               Conversation id (the access "context").
 * @property {string[]} chats                               Chats sharing this context (the link cluster); just [chatId] when unlinked.
 * @property {string[]} mentions                           Ids @mentioned in the message (naming people).
 * @property {boolean} isOwner                             Sender is the bot owner.
 * @property {boolean} isAdmin                             Sender is an admin here (groups).
 * @property {import('./registry.js').Command[]} commands  Registered commands (for help/man).
 * @property {(text: string) => void} reply                Queue a line to send back.
 * @property {(token: string) => string} resolveUser       Canonicalize a typed person id (mention/number) for storage/match.
 * @property {(id: string) => boolean} isSelf              True if the id is the bot itself (its trigger name or own id forms).
 * @property {import('../store/index.js').ScopedStore} [store] Per-conversation scoped KV (when configured).
 * @property {ReturnType<typeof createAccessPolicy>} [access] Owner-managed access lists (when a store is configured).
 * @property {{ propose: () => string, accept: (code: string) => object, adopt: (code: string) => object, unlink: () => object }} [links] Context-link handshake bound to this chat (when a store is configured).
 * @property {import('./log.js').Logger} log               Structured logger (never posts to chat).
 * @property {{ shutdown?: () => void, restart?: () => void, logout?: () => void }} [lifecycle] Process lifecycle controls (owner commands; injected per platform).
 * @property {() => Promise<{ id: string, name: string }[]>} listGroups  Groups the bot is in (platform capability; empty off a group platform).
 * @property {(target: string, text: string) => unknown} [send]  Send a message to any chat/user (proactive; platform capability).
 * @property {() => Promise<string[]>} [participants]  Everyone in this context (all linked chats' participants, deduped, minus the bot).
 * @property {{ add: (when: string, text: string) => object, list: () => object[], cancel: (id: string) => object }} [scheduler] Schedule a message to post later, bound to this chat (when a scheduler is configured).
 * @property {{ exists: boolean, isMe: boolean, fromEnv: boolean, contact: string, claim: () => boolean, resign: () => void }} [owner] Owner-slot management (the `owner` command).
 */

/**
 * Build the message handler that parses `<prefix> <command>`, enforces access
 * (the command's `scope` plus the owner-managed lists), then dispatches. A
 * command's error is caught, so one bad command never crashes the bot. Returns a
 * `handle(msg)` for `createApp`.
 *
 * @param {import('./registry.js').Registry} registry
 * @param {{ prefix?: string, owner?: string, store?: import('../store/index.js').Store, log?: import('./log.js').Logger, match?: (a: string, b: string) => boolean, lifecycle?: object, resolveUser?: (token: string) => string, listGroups?: () => Promise<{ id: string, name: string }[]>, participantsOf?: (chatId: string) => Promise<string[]>, send?: (target: string, text: string) => unknown, scheduler?: { add: (job: object) => object, list: (chatId: string) => object[], cancel: (id: string, chatId: string) => object } }} [opts]
 * @returns {(msg: import('./app.js').InboundMessage) => Promise<string | undefined>}
 */
export function createDispatcher(registry, { prefix = 'jarvis', owner = '', store, log = nullLogger, match, lifecycle, resolveUser, listGroups, participantsOf, send, scheduler } = {}) {
  const ownerResolver = createOwnerResolver({ owner, match });
  const access = store ? createAccessPolicy(store, { match }) : null;
  const links = store ? createLinks(store) : null;

  return async function handle(msg) {
    const parsed = parse(msg.text, prefix, { addressed: msg.addressed });
    if (!parsed) return undefined; // not addressed to the bot

    const { command, args, rest } = parsed;
    const level = msg.level ?? 'private';
    const sender = msg.sender ?? '';
    const chatId = msg.chatId ?? 'cli';
    const ownNs = `${level}:${chatId}`;
    const isAdmin = msg.isAdmin ?? false;
    const isOwner = ownerResolver.isOwner(sender);
    // The bot itself, by its trigger name or its own id forms - so a command can refuse
    // to act on it (e.g. adding the bot to an access list would be meaningless).
    const self = msg.self ?? [];
    const isSelf = (id) => {
      if (!id || id === '*') return false;
      const s = String(id);
      return s.toLowerCase() === prefix.toLowerCase() || self.some((x) => (match ?? sameUser)(s, x));
    };

    // Owner-managed access lists (ADR-0006). The owner bypasses the whole layer, and
    // the bootstrap `owner` command stays reachable so the bot can never be locked
    // out of ownership. The GLOBAL gate is checked before the empty / unknown-command
    // replies, so a blocked sender is fully silent (even to a bare prefix or junk).
    // A denial is logged for audit, never surfaced in chat.
    const exemptFromLists = isOwner || command === 'owner';
    if (access && !exemptFromLists && !access.passes('*', chatId, sender)) {
      log.info('access deny (global)', { sender, chatId });
      return undefined;
    }

    if (!command) return `Try "${prefix} help".`;

    const cmd = registry.get(command);
    if (!cmd) return `Unknown command "${command}". Try "${prefix} help".`;

    // Per-command gate: only a non-owner on a non-owner command is subject to it
    // (owner-only commands are governed by `scope`; `owner` is exempt above).
    if (access && !exemptFromLists && !cmd.scope?.owner && !access.passes(command, chatId, sender)) {
      log.info('access deny (command)', { sender, chatId, command });
      return undefined;
    }

    const scoped = checkScope(cmd.scope, { level, isAdmin, isOwner });
    if (!scoped.ok) return `Not allowed: ${scoped.reason}.`;

    // Owner-slot management for the `owner` command (claim only if free; resign only
    // by the owner). Ownership is established here explicitly, never as a side effect.
    const ownerCap = {
      exists: !!ownerResolver.current,
      isMe: isOwner,
      fromEnv: ownerResolver.fromEnv,
      contact: ownerResolver.current,
      claim: () => {
        if (ownerResolver.current) return false;
        ownerResolver.claim(sender);
        log.warn('owner claimed', { sender });
        return true;
      },
      resign: () => {
        log.warn('owner resigned', { sender });
        ownerResolver.resign();
      },
    };

    const replies = [];
    const ctx = {
      command,
      args,
      rest,
      text: msg.text,
      level,
      sender,
      chatId,
      mentions: msg.mentionedJid ?? [],
      isOwner,
      isAdmin,
      commands: registry.all(),
      reply: (text) => replies.push(text),
      store: store ? store.scoped(links.nsFor(chatId, ownNs)) : undefined,
      chats: links ? links.chats(chatId) : [chatId],
      access: access ?? undefined,
      links: links
        ? {
            propose: () => links.propose(chatId, ownNs),
            accept: (code) => links.accept(code, chatId, ownNs),
            adopt: (code) => links.accept(code, chatId, ownNs, 'adopt'),
            unlink: () => links.unlink(chatId, ownNs),
          }
        : undefined,
      resolveUser: resolveUser ?? ((token) => String(token ?? '').trim()),
      isSelf,
      log,
      lifecycle,
      listGroups: listGroups ?? (() => []),
      send: send ?? undefined,
      participants: participantsOf
        ? async () => {
            const ids = [];
            for (const chat of links ? links.chats(chatId) : [chatId]) {
              for (const p of (await participantsOf(chat)) ?? []) ids.push(p);
            }
            return [...new Set(ids)].filter((id) => !isSelf(id));
          }
        : undefined,
      scheduler: scheduler
        ? {
            add: (when, text) => scheduler.add({ chatId, createdBy: sender, when, text }),
            list: () => scheduler.list(chatId),
            cancel: (id) => scheduler.cancel(id, chatId),
          }
        : undefined,
      owner: ownerCap,
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
