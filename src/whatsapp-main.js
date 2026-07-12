import { writeFileSync } from 'node:fs';
import { createApp } from './core/app.js';
import { createRegistry } from './core/registry.js';
import { createDispatcher } from './core/dispatch.js';
import { createLogger } from './core/log.js';
import { createStore } from './store/index.js';
import { createScheduler } from './core/scheduler.js';
import { createActivation } from './core/activation.js';
import { startProactive } from './core/proactive.js';
import { createSqliteAuthState } from './whatsapp/auth-store.js';
import { createWhatsAppAdapter } from './whatsapp/adapter.js';
import { createDeliver } from './whatsapp/deliver.js';
import { createRateLimiter } from './whatsapp/pacing.js';
import { createIdentityStore } from './whatsapp/identity-store.js';
import { socketLogger } from './whatsapp/socket-logger.js';
import { commands } from './commands/index.js';
import { num } from './core/env.js';
import { createAiClient, buildChatSystem } from './core/ai.js';
import { providerLimits, LIMITS_DOC_DATE } from './core/ai-limits.js';
import { wipeKeepingClaim } from './core/owner.js';
import { loadPersona } from './core/persona.js';

/**
 * Composition root for the live WhatsApp bot. Mirrors `cli.js`, but wires the
 * Baileys adapter instead of the CLI one. App data and auth state live in
 * separate sqlite files so credentials stay isolated. Run with `npm start`.
 */
const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const registry = createRegistry(commands);
const store = createStore({ path: process.env.JARVIS_DB ?? 'data/jarvis.db' });
const authDb = createStore({ path: process.env.JARVIS_AUTH_DB ?? 'data/wa-auth.db' });
const identity = createIdentityStore(store, { log });
const scheduler = createScheduler(store);
const activation = createActivation(store);
// AI (GitHub Models, OpenAI-compatible). With GITHUB_MODELS_TOKEN set, an addressed message that is not
// an exact command is mapped to one or more commands (always-on translation; each still re-checked by
// the dispatcher's guards), and the owner can turn on a per-chat chatbot mode (`jarvis ai on`). No
// token -> the client is null and AI is simply off. The provider is a config triple, swappable to any
// OpenAI-compatible endpoint (Azure AI Foundry, ...) with no code change.
// The chatbot persona (Jarvis's voice in `ai on` mode) is owner-editable via a file: point
// JARVIS_PERSONA_FILE at a file in the data volume and edit it with no rebuild. Empty/missing -> the
// built-in voice. The functional rules are always kept (buildChatSystem), so a persona only sets tone.
const persona = loadPersona(process.env.JARVIS_PERSONA_FILE);
if (persona) log.info('ai: using a custom chatbot persona', { chars: persona.length });
const ai = createAiClient({
  token: process.env.GITHUB_MODELS_TOKEN ?? '',
  baseUrl: process.env.JARVIS_AI_BASE_URL ?? 'https://models.github.ai/inference',
  model: process.env.JARVIS_AI_MODEL ?? 'openai/gpt-4o-mini',
  maxTokens: num(process.env.JARVIS_AI_MAX_TOKENS, 800), // per-completion output bound (cost discipline)
  chatSystem: buildChatSystem(persona),
  log,
});
// Per-group activation gate is opt-in (default on); shared by the dispatcher (inbound) and the
// proactive deliver path (outbound), so both honor the same authorization.
const requireActivation = (process.env.JARVIS_REQUIRE_ACTIVATION ?? 'on') !== 'off';

// libsignal (Baileys' E2E lib) prints session re-establishment straight to the console, bypassing our
// logger: a wall of "Closing open session..." plus a dumped SessionEntry whenever the bot first
// exchanges keys with a new contact. Harmless (normal encryption setup) but noisy, and it logs key
// material - so drop those specific lines. Genuine errors (decrypt failures, etc.) still pass through.
const SIGNAL_NOISE = /Closing (?:open|stale open) session|Closing session:|SessionEntry|message with closed session/;
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && SIGNAL_NOISE.test(args[0])) return;
    orig(...args);
  };
}

// Liveness heartbeat for the container HEALTHCHECK (src/health-check.js reads this file): while
// connected to WhatsApp we stamp the current time here on a short interval, so a stale heartbeat
// (process wedged, or disconnected too long) reports the container unhealthy. See README.
const healthFile = process.env.JARVIS_HEALTH_FILE ?? 'data/health';
let connected = false;
const writeHeartbeat = () => {
  try {
    writeFileSync(healthFile, String(Date.now()));
  } catch (err) {
    log.debug('heartbeat write failed', { error: err?.message ?? String(err) });
  }
};

const adapter = createWhatsAppAdapter({
  authState: createSqliteAuthState(authDb, { logger: socketLogger(log) }),
  log,
  prefix: process.env.JARVIS_PREFIX ?? 'jarvis',
  learn: (key) => identity.learnFromKey(key),
  // Single global send limiter (min spacing between any two sends) + human-timing knobs
  // (read-before-reply receipt, length-proportional typing). All optional; conservative defaults.
  rateLimiter: createRateLimiter({ minIntervalMs: num(process.env.JARVIS_SEND_MIN_INTERVAL_MS, 800) }),
  humanize: {
    markOnline: (process.env.JARVIS_MARK_ONLINE ?? 'on') !== 'off',
    profileName: process.env.JARVIS_PROFILE_NAME ?? 'Jarvis',
    readReceipts: (process.env.JARVIS_READ_RECEIPTS ?? 'on') !== 'off',
    readDelayMs: num(process.env.JARVIS_READ_DELAY_MS, 1000),
    typingPerCharMs: num(process.env.JARVIS_TYPING_PER_CHAR_MS, 50),
    typingMaxMs: num(process.env.JARVIS_TYPING_MAX_MS, 6000),
    sendJitterMs: num(process.env.JARVIS_SEND_JITTER_MS, 400),
  },
  // On logout the creds are wiped; exit non-zero so a supervisor restarts us and
  // shows a fresh QR. In dev (no supervisor) it simply stops - rerun `npm start`.
  onLogout: () => quit(1),
  maxReconnects: num(process.env.JARVIS_MAX_RECONNECTS, 10),
  // Offline-backlog cutoff: wide by design (default 5 min). The filter compares a message's server time
  // to our local connect time, so a generous grace means a skewed host clock never drops a fresh command
  // (see adapter.js). 0 effectively disables it (no message is old enough to drop).
  offlineGraceMs: num(process.env.JARVIS_OFFLINE_GRACE_MS, 5 * 60 * 1000),
  // Fatal disconnect: a session takeover (440), a ban (403), or an unrecoverable session (500) stays
  // DOWN (exit 0) - restarting would re-fight or re-hammer. Reconnect exhaustion gets a clean restart
  // (exit non-zero) so a fresh process can retry from scratch.
  onFatal: (reason) => {
    log.error('wa: fatal disconnect', { reason });
    quit(reason === 'exhausted' ? 1 : 0);
  },
  // The bot was removed from a group: run the dispatcher's FULL teardown (the same one an owner
  // deactivation performs - activation, access lists, AI opt-in, link membership, schedules,
  // auto-replies, and data), so nothing keeps firing into - or stays silently armed for a later
  // re-add of - a chat the bot is no longer in. `handle` is assigned below; group events only fire
  // after start(), so the late binding is safe.
  onRemoved: (chatId) => {
    handle.chatRemoved(chatId);
    log.info('removed group torn down', { chatId });
  },
  // Track connection liveness for the heartbeat: stamp it immediately on connect, and the interval
  // below keeps it fresh while connected (so a disconnect lets it go stale -> unhealthy).
  onConnectionState: (isConnected) => {
    connected = isConnected;
    if (isConnected) writeHeartbeat();
  },
});

// Owner lifecycle controls (the shutdown / restart / logout commands). Each defers
// the exit briefly so the confirmation reply is sent first. A process supervisor is
// what brings Jarvis back after a non-zero exit.
const lifecycle = {
  shutdown: () => { log.warn('owner requested shutdown'); setTimeout(() => quit(0), 1500); },
  restart: () => { log.warn('owner requested restart'); setTimeout(() => quit(1), 1500); },
  logout: () => {
    log.warn('owner requested logout');
    setTimeout(async () => { await adapter.logout(); quit(1); }, 1500);
  },
  wipe: () => {
    log.warn('owner requested a full data wipe (auth kept, ownership kept)');
    // Clear the app db (the auth db is untouched), then restart. The persisted owner claim survives
    // the wipe: the owner runs `reset all` AS the owner - it clears data, it must not un-own the bot
    // (that would reopen the first-claimer window to any stranger after the restart).
    setTimeout(() => { wipeKeepingClaim(store); quit(1); }, 1500);
  },
};

// One typed-token -> JID canonicalization for resolveUser AND forgetIdentity below: an @mention jid
// passes through; a typed number becomes a phone JID; anything else yields '' (each caller keeps its
// own fallback). One helper, so the lookup and the repair accept exactly the same token forms.
const asJid = (token) => {
  const t = String(token ?? '').trim();
  if (!t) return '';
  if (t.includes('@')) return t;
  const digits = t.replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
};

// match is LID-aware so an owner set by phone number matches a LID sender. Captured (not inlined) so the
// scheduled-AI deliver path below can re-enter it with a synthetic message.
const handle = createDispatcher(registry, {
    owner: process.env.OWNER_JID ?? '',
    // Dormant until an owner exists: silent in groups, private only `owner`, until OWNER_JID is set
    // or someone runs `owner claim`. Disable with JARVIS_REQUIRE_OWNER=off.
    requireOwner: (process.env.JARVIS_REQUIRE_OWNER ?? 'on') !== 'off',
    // Per-group activation (ADR-0008): silent in any group until the owner runs `jarvis groups
    // activate` there (or `groups activate <id>` remotely), even if the bot was added by someone
    // else. Disable with JARVIS_REQUIRE_ACTIVATION=off.
    requireActivation,
    store,
    log,
    match: identity.same,
    lifecycle,
    listGroups: () => adapter.listGroups(),
    send: (target, message) => adapter.send(target, message),
    community: adapter.community,
    scheduler,
    ai,
    // Hard daily token budget for the AI layer: once the day's tokens reach it, Jarvis stops calling
    // the model until the next server-local day (deterministic commands keep working). 0 = no cap.
    aiDailyCap: num(process.env.JARVIS_AI_DAILY_TOKEN_CAP, 0),
    // GitHub Models' DOCUMENTED rate limits for the configured model tier + Copilot plan (static -
    // the API exposes no remaining-quota headers), so `jarvis ai` can show the provider's ceilings
    // next to Jarvis's own spend. Unknown combos (custom endpoints) just omit the display.
    aiProvider: (() => {
      // Blank-tolerant on purpose (a blanked `JARVIS_AI_PLAN=` line means "the default", like the
      // project's own num() treats ''): `??` alone would keep '' and silently drop the display.
      const tier = ((process.env.JARVIS_AI_MODEL_TIER ?? '').trim() || 'low').toLowerCase();
      const plan = ((process.env.JARVIS_AI_PLAN ?? '').trim() || 'free').toLowerCase();
      const limits = providerLimits(tier, plan);
      return limits ? { tier, plan, ...limits, docDate: LIMITS_DOC_DATE } : undefined;
    })(),
    // Canonicalize a named person for the access lists: a JID (e.g. from an @mention)
    // is resolved toward its phone form; a bare number becomes a phone JID. Matching
    // then bridges LID <-> phone, so a person named one way matches a sender on the other.
    resolveUser: (token) => {
      const j = asJid(token);
      return j ? identity.resolve(j) : String(token ?? '').trim();
    },
    // Identity repair for `whoami forget`: the SAME token forms as resolveUser (one shared asJid, so
    // the lookup and the repair can never drift apart), dropped from the learned LID<->PN map so the
    // next message re-learns it.
    forgetIdentity: (token) => {
      const j = asJid(token);
      return j ? identity.forget(j) : false;
    },
  });
const app = createApp(adapter, { handle });

// Proactive output (scheduled messages and AI instructions) runs in the background.
// Delivery goes through createDeliver (src/whatsapp/deliver.js): the same activation gate as inbound
// commands (community umbrella included), with AI jobs re-entering the dispatcher carrying the full
// message context. It reuses the adapter's send, which paces every message through the global
// spacing limiter, so output never bursts. Started before the (blocking) start() so the timer is
// live; the first tick is after one interval, so we never deliver before the socket connects.
const deliver = createDeliver({
  send: (chatId, message) => adapter.send(chatId, message),
  communityOf: (chatId) => adapter.communityOf(chatId),
  isActiveVia: (chatId, communityId) => activation.isActiveVia(chatId, communityId),
  handle,
  requireActivation,
  log,
});
const proactiveRunner = startProactive(
  async () => {
    await scheduler.tick(deliver, Date.now());
  },
  { intervalMs: num(process.env.JARVIS_TICK_MS, 30_000), log },
);

// Keep the liveness heartbeat fresh while connected (unref'd so it never holds the process open).
const heartbeat = setInterval(() => { if (connected) writeHeartbeat(); }, num(process.env.JARVIS_HEALTH_INTERVAL_MS, 20_000));
heartbeat.unref();

let closing = false;
const quit = async (code = 0) => {
  if (closing) return;
  closing = true;
  log.info('Jarvis shutting down...');
  clearInterval(heartbeat);
  // process.exit() is in `finally` so it ALWAYS runs: a throw from stop()/close() (e.g. a double
  // close) must not escape as a rejection - that would re-enter quit(), hit the `closing` guard, and
  // leave the process wedged (no exit, no restart). Each close is guarded so a late write can't abort it.
  try {
    await proactiveRunner.stop();
    await adapter.stop();
  } catch (err) {
    log.error('error during shutdown', { error: err?.message ?? String(err) });
  } finally {
    try { store.close(); } catch (err) { log.error('store close failed', { error: err?.message ?? String(err) }); }
    try { authDb.close(); } catch (err) { log.error('auth db close failed', { error: err?.message ?? String(err) }); }
    process.exit(code);
  }
};
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
// Never let an unexpected throw/rejection leave a half-dead process: log it and exit non-zero so the
// supervisor restarts a clean one (better than limping on in an unknown state).
process.on('uncaughtException', (err) => { log.error('uncaught exception', { error: err?.message ?? String(err) }); quit(1); });
process.on('unhandledRejection', (reason) => { log.error('unhandled rejection', { error: reason?.message ?? String(reason) }); quit(1); });

log.info('Jarvis starting on WhatsApp - scan the QR on first run to pair.');
await app.start();
