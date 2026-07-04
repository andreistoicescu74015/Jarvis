import { parse } from './parse.js';
import { checkScope, sameUser } from './scope.js';
import { createOwnerResolver } from './owner.js';
import { createAccessPolicy, accessContextFor } from './access.js';
import { createLinks } from './links.js';
import { createActivation } from './activation.js';
import { createAiUsage } from './ai-usage.js';
import { createAliases } from './aliases.js';
import { nullLogger } from './log.js';
import { b, code, esc } from './format.js';
import { toolCatalog, toCommandLine } from './tools.js';
import { isMisuse } from './reply.js';
import { closest } from './closest.js';
import { createRules, renderTemplate } from './rules.js';

// Upper bound on how many commands one natural-language prompt may run. The model is the only
// non-deterministic input; cap the fan-out so a single request can never spray an unbounded number
// of state-changing commands (each still passes every guard, but the count itself is bounded).
const AI_MAX_CHAIN = 8;

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
 * @property {string} [communityId]                        Parent community jid of this chat, when in one (the target for community-wide activation).
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
 * @property {{ isActive: (id: string) => boolean, activate: (id: string, by?: string) => boolean, deactivate: (id: string) => boolean, activateCommunity: (id: string, by?: string) => boolean, deactivateCommunity: (id: string) => boolean, list: () => string[] }} [activation] Per-group activation registry, plus the community umbrella (ADR-0008; when a store is configured).
 * @property {{ propose: () => string, accept: (code: string) => object, unlink: () => object }} [links] Context-link (overlay) handshake bound to this chat (when a store is configured).
 * @property {import('./log.js').Logger} log               Structured logger (never posts to chat).
 * @property {{ shutdown?: () => void, restart?: () => void, logout?: () => void }} [lifecycle] Process lifecycle controls (owner commands; injected per platform).
 * @property {() => Promise<{ id: string, name: string }[]>} listGroups  Groups the bot is in (platform capability; empty off a group platform).
 * @property {(target: string, text: string) => unknown} [send]  Send a message to any chat/user (proactive; platform capability).
 * @property {{ info: (id?: string) => Promise<import('../whatsapp/community.js').Community | undefined>, groups: (id?: string) => Promise<object[]>, all: () => Promise<object[]> }} [community] WhatsApp community reads (metadata + linked sub-groups; platform capability, absent off WhatsApp). `info`/`groups` default to the current chat's community.
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
 * @param {{ prefix?: string, owner?: string, store?: import('../store/index.js').Store, log?: import('./log.js').Logger, match?: (a: string, b: string) => boolean, lifecycle?: object, resolveUser?: (token: string) => string, listGroups?: () => Promise<{ id: string, name: string }[]>, send?: (target: string, text: string) => unknown, community?: { info: (id?: string) => Promise<object | undefined>, groups: (id?: string) => Promise<object[]>, all: () => Promise<object[]> }, scheduler?: { add: (job: object) => object, list: (chatId: string) => object[], cancel: (id: string, chatId: string) => object }, ai?: { translate: (input: { text: string, tools: object[] }) => Promise<Array<{ command: string, args: object }> | null> }, requireOwner?: boolean, requireActivation?: boolean }} [opts]
 * @returns {((msg: import('./app.js').InboundMessage) => Promise<string | undefined>) & { chatRemoved: (chatId: string) => void }}
 *   The message handler, plus `chatRemoved(chatId)` - the platform's removal hook (the bot was kicked
 *   from a chat): deactivate it and run the same full teardown `groups deactivate` performs.
 */
export function createDispatcher(registry, { prefix = 'jarvis', owner = '', store, log = nullLogger, match, lifecycle, resolveUser, listGroups, send, community, scheduler, ai, aiDailyCap = 0, requireOwner = false, requireActivation = false } = {}) {
  const ownerResolver = createOwnerResolver({ owner, match });
  const access = store ? createAccessPolicy(store, { match }) : null;
  const activation = store ? createActivation(store) : null;
  const links = store
    ? createLinks(store, {
        isActivated: (id) => activation.isActive(id), // a group must be active to link
        clearNamespace: (ns) => store.clearNamespace(ns), // drop a dissolved overlay's shared data
      })
    : null;
  // Token accounting for every model call (per access-context + global), so the owner can see what the
  // AI layer costs. Storage-only; a safe no-op without a store.
  const aiUsage = store ? createAiUsage(store) : null;
  // Owner-defined command aliases (the `alias` command): short names that expand to a full command line,
  // run deterministically before the AI branch. Global, store-backed; a safe no-op without a store.
  const aliases = store ? createAliases(store) : null;
  // Owner/admin-defined keyword auto-replies (the `rule` command): an addressed keyword posts a templated
  // reply deterministically (no AI), checked after real commands and aliases. Per-chat, store-backed.
  const rules = store ? createRules(store) : null;
  // Per-context CHATBOT mode (the `ai` command). Command translation is ALWAYS on; this gate only
  // controls whether Jarvis also answers general questions conversationally when nothing maps to a
  // command. Off by default; the owner opens it per chat with `jarvis ai on`.
  const aiGateStore = store ? store.scoped('ai-enabled') : null;
  const aiEnabledIn = (context) => !!aiGateStore?.get(context);

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
  // Full teardown of one chat's footprint - shared by the owner's deactivate and the platform's
  // removal hook (`handle.chatRemoved`), so the two paths can never drift apart. Everything a chat
  // accumulates goes with it.
  function teardownChat(id) {
    if (access) access.clearContext(id); // tear down the chat's access lists with it
    aiGateStore?.delete(id); // and its AI-chatbot opt-in (a teardown is a full reset)
    if (links) links.unlink(id); // leave any link overlay (revert, or dissolve it if this splits the rest)
    scheduler?.clearChat(id); // stop the chat's proactive output (scheduled jobs), so a teardown truly silences it
    rules?.clearChat(id); // ...and its keyword auto-replies (chat data, gone with the chat)
    if (store) {
      store.clearNamespace(`group:${id}`); // wipe the chat's own data too - a teardown is a full reset
      store.clearNamespace(`community:${id}`);
    }
  }
  function deactivateGroup(id) {
    if (!activation) return false;
    const was = activation.deactivate(id);
    if (was) teardownChat(id); // idempotent: deactivating an already-inactive group changes nothing
    return was;
  }

  // Translate a natural-language request via the AI client (best-effort). Returns the resolved command
  // CHAIN (each step a canonical command line ready to dispatch through every guard) and, in chat mode,
  // a plain-text ANSWER the model wrote when nothing mapped. Either may be empty/null; both are when AI
  // is off or the call fails. Each resolved command still runs through every guard below, so AI can
  // never reach a command the caller could not have typed by hand.
  async function aiResolve(request, scopeCtx, chat, context) {
    const tools = toolCatalog(registry.all(), scopeCtx);
    if (!tools.length) return { chain: [], answer: null };
    // Daily AI budget (hard cap): once the day's tokens reach the cap, stop calling the model until the
    // next server-local day - the deterministic bot keeps working, the AI layer just goes quiet. Off
    // when aiDailyCap <= 0. One chokepoint, so it bounds translation, chatbot answers, and timer jobs alike.
    if (aiUsage && !aiUsage.allows(aiDailyCap)) {
      log.info('ai: daily token cap reached - skipping the model call', { context, cap: aiDailyCap });
      return { chain: [], answer: null };
    }
    let result;
    try {
      // The translator is best-effort and must never crash the deterministic bot (ADR-0003): the
      // production client swallows its own errors, but an injected/alternate one might throw - isolate it.
      result = await ai.translate({ text: request, tools, chat });
    } catch (err) {
      log.error('ai: translation threw', { error: err?.message ?? String(err) });
      return { chain: [], answer: null };
    }
    if (aiUsage && result?.usage) aiUsage.record(context, result.usage); // account the tokens this call cost
    const proposals = Array.isArray(result?.commands) ? result.commands : [];
    const chain = [];
    for (const p of proposals) {
      let line;
      try {
        line = toCommandLine(registry.get(p.command), p.args);
      } catch {
        continue; // skip an incomplete proposal (a missing required argument)
      }
      const reparsed = parse(line, prefix, { addressed: true });
      const cmd = reparsed?.command ? registry.get(reparsed.command) : undefined;
      if (cmd) chain.push({ cmd, command: reparsed.command, args: reparsed.args, rest: reparsed.rest, line });
    }
    if (chain.length > AI_MAX_CHAIN) {
      log.info('ai: truncating an over-long command chain', { proposed: chain.length, cap: AI_MAX_CHAIN });
      return { chain: chain.slice(0, AI_MAX_CHAIN), answer: null };
    }
    return { chain, answer: result?.answer ?? null };
  }

  // A KNOWN command that could not interpret its arguments (a `misuse` reply) - ask the model what the
  // user likely meant and return a one-line suggestion (never auto-run). Best-effort: null if AI is off
  // or nothing maps. Reuses aiResolve, so the suggestion is scope-filtered and canonical.
  async function aiSuggest(request, scopeCtx, context) {
    const { chain } = await aiResolve(request, scopeCtx, false, context);
    if (!chain.length) return null;
    const lines = chain.map((s) => code(`${prefix} ${s.line}`)).join(' ; ');
    return `Did you mean: ${lines}? Type it to run.`;
  }

  async function handle(msg) {
    const parsed = parse(msg.text, prefix, { addressed: msg.addressed });
    if (!parsed) return undefined; // not addressed to the bot

    const { command, args, rest } = parsed;
    const level = msg.level ?? 'private';
    const sender = msg.sender ?? '';
    const chatId = msg.chatId ?? 'cli';
    const ownNs = `${level}:${chatId}`;
    const accessContext = accessContextFor(level, chatId); // 'private' for any DM, else the chat id
    // The community this chat belongs to (announcement group = itself, a sub-group = its parent), so
    // `ctx.community.info()` targets the right jid with no argument. Threaded from the inbound metadata.
    const communityId = msg.community ?? (level === 'community' ? chatId : undefined);
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
    // A group/community is active if its own id is activated OR its parent community is (the community
    // umbrella: activating a community opens the silence gate for every group in it, including ones
    // added later). `communityId` is the chat's community - itself for an announcement group.
    const activeHere = activation && (activation.isActive(chatId) || (communityId && activation.isActive(communityId)));
    if (
      requireActivation &&
      activation &&
      (level === 'group' || level === 'community') &&
      !activeHere
    ) {
      if (!isOwner || msg.scheduled) {
        // A non-owner stays silent until the owner activates the group; a SCHEDULED job never
        // auto-activates a group from a timer (it just yields nothing for an inactive destination).
        log.info('inactive group: not activated', { chatId, command, sender, scheduled: !!msg.scheduled });
        return undefined;
      }
      // The owner's mere address authorizes the group: any message (even a bare "jarvis") activates
      // it, then proceeds. `groups`/`community` are the exception - they activate explicitly, so their
      // own confirmation reads cleanly and is not pre-empted here.
      if (command !== 'groups' && command !== 'community') {
        if (level === 'community' && communityId === chatId) {
          // The announcement group's id IS the community id: addressing it activates the WHOLE
          // community leanly (umbrella, gate-only - no admins-only reset, no announce), consistent
          // with `community activate`. No announce, so a bare prefix falls through to "Try help".
          activation.activate(chatId, sender);
        } else {
          // A normal group or a community sub-group: the usual admins-only reset + announce.
          await activateGroup(chatId, sender);
          if (!command) return undefined; // bare prefix: the announce IS the reply (no "Try help")
        }
      }
    }

    // Owner-managed access lists (ADR-0006). The owner bypasses the whole layer, and while the bot is
    // UNOWNED the bootstrap `owner` command stays reachable so it can never be locked out of ownership.
    // Once an owner exists that exemption ends: `owner` obeys the lists like any command, so a
    // locked-out stranger can no longer probe the bot (or learn who owns it) through it. The GLOBAL
    // gate is checked before the empty / unknown-command replies, so a blocked sender is fully silent
    // (even to a bare prefix or junk). A denial is logged for audit, never surfaced in chat. The owner
    // bypasses the lists everywhere; a group/community admin bypasses them in their own (already-active)
    // chat - admins always have access where Jarvis runs.
    const globalExempt = isOwner || isAdmin || (command === 'owner' && !ownerResolver.current);
    if (access && !globalExempt && !access.passes('*', accessContext, sender)) {
      log.info('access deny (global)', { sender, chatId });
      return undefined;
    }

    if (!command) return `Try ${code(`${prefix} help`)}.`;

    // `capable` / `ownerCap` are message-scoped but command-independent, so they are built once and
    // shared by every command run below (a single typed command, or each step of an AI chain).
    const capable = { store, access, links, activation, scheduler, rules, lifecycle, send, community, aliases, aiGate: aiGateStore };
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

    // Run ONE already-resolved command: its per-command access list, scope, and capability checks,
    // then execute it. Returns the reply (or a denial), or undefined when silently blocked or it
    // produced nothing. Shared by the typed path and EACH step of an AI-translated chain, so every
    // command - however it arrived - passes the same guards (the owner/admin/`owner`-command bypass
    // the lists; owner-only commands are governed by `scope`).
    async function runOne(cmd, command, args, rest, aiLine) {
      const exempt = isOwner || isAdmin || (command === 'owner' && !ownerResolver.current);
      if (access && !exempt && !cmd.scope?.owner && !access.passes(command, accessContext, sender)) {
        log.info('access deny (command)', { sender, chatId, command });
        return undefined;
      }
      const scoped = checkScope(cmd.scope, { level, isAdmin, isOwner });
      if (!scoped.ok) return `Not allowed: ${scoped.reason}.`;
      if (cmd.requires?.some((cap) => !capable[cap])) return 'That command is unavailable here.';

      // INDIRECT invocation (aiLine set = an AI translation OR an alias expansion): a SENSITIVE command -
      // one that affects the bot itself (owner/reset/shutdown/restart/logout) or destroys data (a
      // destructive SUBCOMMAND like `note clear`, `groups deactivate`) - is only ever suggested, never
      // auto-run. Checked AFTER the access/scope guards, so a command the caller could not run anyway
      // reports that, not a misleading suggestion. A SENSITIVE command (cmd.confirm) needs a human's
      // explicit consent: indirectly (an AI guess, or an alias that may expand to a destructive command the
      // owner did not realize) it is suggested with the real line to type; on a timer (scheduled) it is
      // skipped (no one to confirm); typed directly it runs below (the typing IS the consent).
      if (aiLine || msg.scheduled) {
        const needsConfirm = typeof cmd.confirm === 'function' ? cmd.confirm(args) : !!cmd.confirm;
        if (needsConfirm) {
          if (msg.scheduled) { log.info('scheduled: skipped a sensitive command', { command }); return undefined; }
          return `I won't auto-run a sensitive command indirectly - type ${code(`${prefix} ${aiLine}`)} yourself to confirm.`;
        }
      }

      const replies = [];
      const ctx = {
        command,
        args,
        rest,
        text: msg.text,
        level,
        sender,
        chatId,
        communityId,
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
              // Community umbrella (silence gate only - no access reset, no announce): activating a
              // community id authorizes every group under it. Raw on purpose, unlike activate() above.
              activateCommunity: (id, by = sender) => activation.activate(id, by),
              deactivateCommunity: (id) => activation.deactivate(id),
              list: () => activation.list(),
            }
          : undefined,
        // AI-translation opt-in for this context (the `ai` command); owner is exempt from the gate.
        aiGate: aiGateStore
          ? {
              isOn: () => aiEnabledIn(accessContext),
              on: () => aiGateStore.set(accessContext, true),
              off: () => aiGateStore.delete(accessContext),
              available: !!ai,
            }
          : undefined,
        // AI token accounting for this context (read-only, for the owner's `ai` command): the cumulative
        // summary plus today's spend and the configured daily cap (so the command can show the budget).
        aiUsage: aiUsage ? { summary: () => aiUsage.summary(accessContext), today: () => aiUsage.today(), cap: aiDailyCap } : undefined,
        // Owner-defined command aliases (the `alias` command manages them; the dispatcher expands them above).
        aliases: aliases ?? undefined,
        links: links
          ? {
              propose: () => links.propose(chatId),
              accept: (code) => links.accept(code, chatId),
              unlink: () => links.unlink(chatId),
              clusters: () => links.clusters(),
            }
          : undefined,
        resolveUser: resolveUser ?? ((token) => String(token ?? '').trim()),
        isSelf,
        log,
        lifecycle,
        listGroups: listGroups ?? (() => []),
        send: send ?? undefined,
        // Community reads, bound to this chat's community by default (pass an id to target another).
        community: community
          ? {
              info: (id = communityId) => community.info(id),
              groups: (id = communityId) => community.groups(id),
              all: () => community.all(),
            }
          : undefined,
        // Keyword auto-replies for this chat (the `rule` command); the dispatcher fires them below.
        rules: rules
          ? {
              add: (keyword, reply) => rules.add({ chatId, createdBy: sender, keyword, reply }),
              list: () => rules.list(chatId),
              remove: (keyword) => rules.remove(chatId, keyword),
            }
          : undefined,
        scheduler: scheduler
          ? {
              add: (when, text, kind) => scheduler.add({ chatId, createdBy: sender, when, text, kind }),
              addNatural: (input, kind) => scheduler.addNatural({ chatId, createdBy: sender, input, kind }),
              list: () => scheduler.list(chatId),
              cancel: (id) => scheduler.cancel(id, chatId),
              clear: () => scheduler.clearChat(chatId),
              setEnabled: (id, on) => scheduler.setEnabled(id, chatId, on),
              setEnabledAll: (on) => scheduler.setEnabledAll(chatId, on),
            }
          : undefined,
        // Owner reset: wipe THIS context's DATA - its notes, schedules, and keyword auto-replies. NOT
        // its access lists: those are managed via whitelist/blacklist, and silently clearing them on a
        // reset would open the chat up (a security regression). A full access reset is what deactivate
        // -> reactivate already does. The notes ns is the link overlay when linked (a linked group
        // clears the shared notes); schedules and rules are per-chat.
        resetContext: store
          ? () => {
              store.clearNamespace(links ? links.nsFor(chatId, ownNs) : ownNs);
              if (scheduler) scheduler.clearChat(chatId);
              if (rules) rules.clearChat(chatId);
            }
          : undefined,
        owner: ownerCap,
      };

      try {
        const result = await cmd.run(ctx);
        if (isMisuse(result)) {
          // The command could not interpret the arguments. On the typed path, offer a best-effort AI
          // suggestion of what the user likely meant (never auto-run); on an AI-chain step, or with no
          // AI, just surface the usage text. The access/scope guards above already passed, so the
          // suggestion is for someone who may run the command - it only clarifies the syntax.
          if (!aiLine && ai) {
            const request = rest ? `${command} ${rest}` : command;
            const suggestion = await aiSuggest(request, { level, isAdmin, isOwner }, accessContext);
            if (suggestion) return `${result.text}\n${suggestion}`;
          }
          return result.text;
        }
        if (result != null && result !== '') replies.push(String(result));
      } catch (err) {
        // A command failure is logged internally and never surfaced in chat: it would be noise and
        // could leak internals. Any partial replies are dropped.
        log.error(`command "${command}" failed`, { error: err?.message ?? String(err), sender, level });
        return undefined;
      }
      return replies.length ? replies.join('\n') : undefined;
    }

    const known = registry.get(command);
    if (known) return runOne(known, command, args, rest); // a known command: run it directly

    // Owner-defined alias: an exact match on a shortcut name expands to its command line and runs through
    // the SAME guards via runOne (deterministic, no AI - and it pre-empts the fuzzy/AI branches below, so a
    // shortcut never costs a model call). Checked AFTER real commands (so it can't shadow one) and expanded
    // ONE level (the target is a literal command, never re-aliased), so aliases cannot loop. Text typed
    // after the alias name is appended. The target is still scope/access-checked in runOne, so an alias can
    // never run a command the caller could not type by hand.
    const aliasTarget = aliases?.get(command);
    if (aliasTarget) {
      const expanded = rest ? `${aliasTarget} ${rest}` : aliasTarget;
      const reparsed = parse(expanded, prefix, { addressed: true });
      const target = reparsed?.command ? registry.get(reparsed.command) : undefined;
      // Pass the expanded line so runOne applies the sensitive-command (confirm) guard: an alias is a
      // typed shortcut, but a shortcut to a destructive/owner command (e.g. `bye` -> `logout`) must not
      // auto-run - runOne refuses and tells the owner to type the real command. A non-sensitive target
      // runs normally (the guard is a no-op). The target is still scope/access-checked, so no escalation.
      if (target) return runOne(target, reparsed.command, reparsed.args, reparsed.rest, expanded);
      log.info('alias: target is not a known command', { alias: command, target: reparsed?.command });
      return `Alias ${code(esc(command))} points to an unknown command.`;
    }

    // Owner/admin-defined keyword auto-reply (a deterministic rule): an exact keyword match posts a
    // templated reply - no command, no AI, no tokens. Checked AFTER real commands and aliases (so it
    // never shadows either) and before the fuzzy/AI branches. Reached only here: only on a message
    // addressed to the bot in an already-authorized, active chat (the access + activation gates ran above).
    const matchedRule = rules?.match(chatId, command);
    if (matchedRule) {
      log.info('rule: keyword auto-reply', { keyword: command, chatId, sender });
      return renderTemplate(matchedRule.reply, { sender, chat: chatId });
    }

    // A near-miss of a real command (a typo): suggest the correction deterministically - no LLM, and it
    // pre-empts the AI translation branch below (so a typo never costs a model call). Suggest, never
    // auto-run: a mistyped sensitive command (e.g. `logout`) must not fire, and the line is rebuilt with
    // the corrected name plus the original args, so it is ready to send.
    const guess = closest(command, registry.all().map((c) => c.name));
    if (guess) return `Did you mean ${code(`${prefix} ${guess}${rest ? ` ${rest}` : ''}`)}? Type it to run.`;

    // Not a known command, but the user addressed Jarvis. Command TRANSLATION is always on (best-effort):
    // map the natural-language request onto one or more commands (a chain) and run each through runOne -
    // the model only proposes; every guard applies per step, and a sensitive command is suggested, not
    // auto-run. The access gate above already silenced anyone not allowed here, so this never runs for
    // them. When nothing maps and the owner has turned on chatbot mode (`jarvis ai on`), the model's own
    // answer is returned; otherwise a friendly nudge toward `help`. The reply leads with the command(s)
    // it understood, so the user sees (and learns) exactly what ran.
    if (ai) {
      const request = rest ? `${command} ${rest}` : command;
      // `ai on` => also answer general questions here. A SCHEDULED job forces it on (the owner
      // authorized this output), so a non-command instruction still gets a composed answer.
      const chatOn = aiEnabledIn(accessContext) || !!msg.scheduled;
      const { chain, answer } = await aiResolve(request, { level, isAdmin, isOwner }, chatOn, accessContext);
      if (chain.length) {
        log.info('ai: translated a request', { to: chain.map((s) => s.line), sender });
        const understood = `${b('Understood:')} ${chain.map((s) => code(`${prefix} ${s.line}`)).join(' ; ')}`;
        const outs = [];
        for (const step of chain) {
          // Pass step.line so runOne can apply the sensitive-command guard (after its own access/scope
          // checks) and, when it blocks, tell the user exactly what to type to run it.
          const out = await runOne(step.cmd, step.command, step.args, step.rest, step.line);
          if (out) outs.push(out);
        }
        // A scheduled job posts only the command results (no "Understood:" preamble - no human to teach);
        // if every step was skipped (e.g. all sensitive), it posts nothing.
        if (msg.scheduled) return outs.length ? outs.join('\n') : undefined;
        return [understood, ...outs].join('\n');
      }
      if (chatOn && answer) return esc(answer); // chatbot mode (or a scheduled job): a composed reply
      if (msg.scheduled) return undefined; // a timer posts nothing rather than the friendly nudge
      return `I didn't catch a command in that. Try ${code(`${prefix} help`)} to see what I can do.`;
    }
    return `Unknown command ${code(esc(command))}. Try ${code(`${prefix} help`)}.`;
  }

  // Platform hook: the bot was REMOVED from a chat (kicked, or the group was deleted). Same full
  // teardown as an owner deactivation - nothing may keep firing into, or stay silently armed for a
  // later re-add of, a chat the bot is no longer in - but unconditional: it also covers a chat with
  // no own activation entry (active via a community umbrella, or activation not required), which
  // `deactivate` alone would skip.
  handle.chatRemoved = (chatId) => {
    activation?.deactivate(chatId);
    teardownChat(chatId);
  };
  return handle;
}
