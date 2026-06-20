import { parse } from './parse.js';
import { checkScope, sameUser } from './scope.js';
import { createOwnerResolver } from './owner.js';
import { createAccessPolicy, accessContextFor } from './access.js';
import { createLinks } from './links.js';
import { createActivation } from './activation.js';
import { nullLogger } from './log.js';
import { b, code, esc } from './format.js';

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
 * @property {{ isActive: (id: string) => boolean, activate: (id: string, by?: string) => boolean, deactivate: (id: string) => boolean, list: () => string[] }} [activation] Per-group activation registry (ADR-0008; when a store is configured).
 * @property {{ propose: () => string, accept: (code: string) => object, unlink: () => object }} [links] Context-link (overlay) handshake bound to this chat (when a store is configured).
 * @property {import('./log.js').Logger} log               Structured logger (never posts to chat).
 * @property {{ shutdown?: () => void, restart?: () => void, logout?: () => void }} [lifecycle] Process lifecycle controls (owner commands; injected per platform).
 * @property {() => Promise<{ id: string, name: string }[]>} listGroups  Groups the bot is in (platform capability; empty off a group platform).
 * @property {(target: string, text: string) => unknown} [send]  Send a message to any chat/user (proactive; platform capability).
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
 * @param {{ prefix?: string, owner?: string, store?: import('../store/index.js').Store, log?: import('./log.js').Logger, match?: (a: string, b: string) => boolean, lifecycle?: object, resolveUser?: (token: string) => string, listGroups?: () => Promise<{ id: string, name: string }[]>, send?: (target: string, text: string) => unknown, scheduler?: { add: (job: object) => object, list: (chatId: string) => object[], cancel: (id: string, chatId: string) => object }, requireOwner?: boolean, requireActivation?: boolean }} [opts]
 * @returns {(msg: import('./app.js').InboundMessage) => Promise<string | undefined>}
 */
export function createDispatcher(registry, { prefix = 'jarvis', owner = '', store, log = nullLogger, match, lifecycle, resolveUser, listGroups, send, scheduler, requireOwner = false, requireActivation = false } = {}) {
  const ownerResolver = createOwnerResolver({ owner, match });
  const access = store ? createAccessPolicy(store, { match }) : null;
  const activation = store ? createActivation(store) : null;
  const links = store
    ? createLinks(store, {
        isActivated: (id) => activation.isActive(id), // a group must be active to link
        clearNamespace: (ns) => store.clearNamespace(ns), // drop a dissolved overlay's shared data
      })
    : null;

  // First-owner lockdown: the moment an owner is established (OWNER_JID at startup, or `owner claim`),
  // lock Jarvis's DMs to them by enabling the private whitelist - a stranger can no longer DM the bot.
  // Done once (a flag in the store), so a later `whitelist * disable` by the owner survives restarts.
  const lockPrivateOnce = () => {
    if (!store || !access) return;
    const meta = store.scoped('owner-meta');
    if (meta.get('privateLocked')) return;
    access.enable('whitelist', '*', 'private');
    meta.set('privateLocked', true);
  };
  if (ownerResolver.current) lockPrivateOnce(); // env owner: lock at startup

  // Activating a group authorizes it AND resets it to a clean, admins-only baseline: each activation
  // wipes the group's prior lists, then enables an empty whitelist on the whole bot (so only admins,
  // who bypass, can use it until an admin whitelists others or opens it up), and announces in the
  // group. Idempotent - re-activating an already-active group does nothing. Shared by the `groups`
  // command and the owner's auto-activation in the gate below.
  const activationNotice = () =>
    [
      b('Jarvis is active here.'),
      `Admins can use me right away. By default only admins can - to let others in an admin runs ` +
        `${code(`${prefix} whitelist * add @person`)}, or opens me to everyone with ${code(`${prefix} whitelist * disable`)}. ` +
        `Type ${code(`${prefix} help`)} to see what I can do.`,
    ].join('\n');

  async function activateGroup(id, by) {
    if (!activation || !activation.activate(id, by)) return false; // no activation, or already active
    if (access) {
      access.clearContext(id); // a fresh activation starts from clean lists...
      access.enable('whitelist', '*', id); // ...locked to admins (who bypass) until an admin opens it
    }
    if (send) await send(id, activationNotice());
    return true;
  }
  function deactivateGroup(id) {
    if (!activation) return false;
    const was = activation.deactivate(id);
    if (was) {
      if (access) access.clearContext(id); // tear down the group's lists with it
      if (links) links.unlink(id); // leave any link overlay (revert, or dissolve it if this splits the rest)
      if (store) {
        store.clearNamespace(`group:${id}`); // wipe the group's own data too - a deactivate is a full reset
        store.clearNamespace(`community:${id}`);
      }
    }
    return was;
  }

  return async function handle(msg) {
    const parsed = parse(msg.text, prefix, { addressed: msg.addressed });
    if (!parsed) return undefined; // not addressed to the bot

    const { command, args, rest } = parsed;
    const level = msg.level ?? 'private';
    const sender = msg.sender ?? '';
    const chatId = msg.chatId ?? 'cli';
    const ownNs = `${level}:${chatId}`;
    const accessContext = accessContextFor(level, chatId); // 'private' for any DM, else the chat id
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

    // Activation gate: until an owner exists (set via OWNER_JID or claimed with `owner claim`),
    // Jarvis stays DORMANT when `requireOwner` is on - silent in every group, and in a private chat
    // only the `owner` command responds (the claim path). So a freshly deployed bot does nothing
    // until its manager takes ownership. Fully suppressed (no reply at all), like the access layer
    // below; the `owner` command is what establishes the owner and opens the gate.
    if (requireOwner && !ownerResolver.current && !(level === 'private' && command === 'owner')) {
      log.info('dormant: no owner yet', { level, command, sender });
      return undefined;
    }

    // Per-group activation gate (ADR-0008): a group or community is inactive until the owner
    // activates it (`jarvis groups activate`), so Jarvis acts in a group only where the owner
    // authorized it - even if someone else added the bot there. The owner's `groups` command
    // passes even in an inactive group, so activation can be done from inside. Private chats are
    // never gated here. Opt-in via requireActivation (off for the dev CLI and unit tests); fully
    // suppressed (no reply), like the gates around it.
    if (
      requireActivation &&
      activation &&
      (level === 'group' || level === 'community') &&
      !activation.isActive(chatId)
    ) {
      if (!isOwner) {
        log.info('inactive group: not activated', { chatId, command, sender });
        return undefined; // a non-owner stays silent until the owner activates the group
      }
      // The owner's mere address authorizes the group: any message (even a bare "jarvis") activates
      // it, then proceeds. `groups` is the exception - it activates explicitly, so its own
      // confirmation reads cleanly and is not pre-empted here.
      if (command !== 'groups') {
        await activateGroup(chatId, sender);
        if (!command) return undefined; // bare prefix: the activation notice is the reply (no "Try help")
        // else fall through and run the command in the now-active group
      }
    }

    // Owner-managed access lists (ADR-0006). The owner bypasses the whole layer, and
    // the bootstrap `owner` command stays reachable so the bot can never be locked
    // out of ownership. The GLOBAL gate is checked before the empty / unknown-command
    // replies, so a blocked sender is fully silent (even to a bare prefix or junk).
    // A denial is logged for audit, never surfaced in chat.
    // The owner bypasses the lists everywhere; a group/community admin bypasses them in their own
    // (already-active) chat - admins always have access where Jarvis runs. The bootstrap `owner`
    // command stays exempt so the bot can never be locked out of ownership.
    const exemptFromLists = isOwner || isAdmin || command === 'owner';
    if (access && !exemptFromLists && !access.passes('*', accessContext, sender)) {
      log.info('access deny (global)', { sender, chatId });
      return undefined;
    }

    if (!command) return `Try ${code(`${prefix} help`)}.`;

    const cmd = registry.get(command);
    if (!cmd) return `Unknown command ${code(esc(command))}. Try ${code(`${prefix} help`)}.`;

    // Per-command gate: only a non-owner on a non-owner command is subject to it
    // (owner-only commands are governed by `scope`; `owner` is exempt above).
    if (access && !exemptFromLists && !cmd.scope?.owner && !access.passes(command, accessContext, sender)) {
      log.info('access deny (command)', { sender, chatId, command });
      return undefined;
    }

    const scoped = checkScope(cmd.scope, { level, isAdmin, isOwner });
    if (!scoped.ok) return `Not allowed: ${scoped.reason}.`;

    // Declarative capability requirements: a command lists the ctx capabilities it needs
    // (e.g. `requires: ['scheduler']`). When one isn't wired on this platform/config, the
    // command is uniformly reported unavailable, instead of each command hand-rolling a guard.
    const capable = { store, access, links, activation, scheduler, lifecycle, send };
    if (cmd.requires?.some((cap) => !capable[cap])) {
      return 'That command is unavailable here.';
    }

    // Owner-slot management for the `owner` command (claim only if free; resign only
    // by the owner). Ownership is established here explicitly, never as a side effect.
    const ownerCap = {
      exists: !!ownerResolver.current,
      isMe: isOwner,
      fromEnv: ownerResolver.fromEnv,
      contact: ownerResolver.current,
      claim: () => {
        // A free slot can only be claimed from a private chat: ownership is a direct,
        // DM-level act, so a stranger can't seize the bot from inside a group it joined.
        if (ownerResolver.current || level !== 'private') return false;
        ownerResolver.claim(sender);
        log.warn('owner claimed', { sender });
        lockPrivateOnce(); // the first owner -> lock the bot's DMs to them by default
        return true;
      },
      resign: () => {
        log.warn('owner resigned', { sender });
        ownerResolver.resign();
        // Symmetric with the claim-time lock: clear the private lockdown so the next owner re-locks
        // cleanly, and DMs are not left with an owner-less empty whitelist only `owner` can see past.
        if (store && access) {
          access.disable('*', 'private');
          store.scoped('owner-meta').delete('privateLocked');
        }
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
      // The bot's own id forms are dropped: when the bot is addressed by @mention, its own jid
      // is among `mentionedJid` (often first), and a command naming a person (e.g. the access
      // lists) must take the named person, not the bot. Mirrors `stripBotMention` on the text.
      mentions: (msg.mentionedJid ?? []).filter((id) => !isSelf(id)),
      isOwner,
      isAdmin,
      commands: registry.all(),
      reply: (text) => replies.push(text),
      store: store ? store.scoped(links.nsFor(chatId, ownNs)) : undefined,
      chats: links ? links.chats(chatId) : [chatId],
      access: access ?? undefined,
      activation: activation
        ? {
            isActive: (id) => activation.isActive(id),
            activate: (id, by = sender) => activateGroup(id, by),
            deactivate: (id) => deactivateGroup(id),
            list: () => activation.list(),
          }
        : undefined,
      links: links
        ? {
            propose: () => links.propose(chatId),
            accept: (code) => links.accept(code, chatId),
            unlink: () => links.unlink(chatId),
          }
        : undefined,
      resolveUser: resolveUser ?? ((token) => String(token ?? '').trim()),
      isSelf,
      log,
      lifecycle,
      listGroups: listGroups ?? (() => []),
      send: send ?? undefined,
      scheduler: scheduler
        ? {
            add: (when, text) => scheduler.add({ chatId, createdBy: sender, when, text }),
            list: () => scheduler.list(chatId),
            cancel: (id) => scheduler.cancel(id, chatId),
            clear: () => scheduler.clearChat(chatId),
          }
        : undefined,
      // Owner reset: wipe THIS context's DATA - its notes and schedules. NOT its access lists: those
      // are managed via whitelist/blacklist, and silently clearing them on a reset would open the chat
      // up (a security regression). A full access reset is what deactivate -> reactivate already does.
      // The chat's data ns is the link overlay when linked, so a linked group clears the shared cluster.
      resetContext: store
        ? () => {
            store.clearNamespace(links ? links.nsFor(chatId, ownNs) : ownNs);
            if (scheduler) scheduler.clearChat(chatId);
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
