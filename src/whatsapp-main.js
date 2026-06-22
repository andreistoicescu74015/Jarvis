import { writeFileSync } from 'node:fs';
import { isJidGroup } from 'baileys';
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
import { createRateLimiter } from './whatsapp/pacing.js';
import { createIdentityStore } from './whatsapp/identity-store.js';
import { socketLogger } from './whatsapp/socket-logger.js';
import { commands } from './commands/index.js';
import { num } from './core/env.js';
import { createAiClient } from './core/ai.js';

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
const ai = createAiClient({
  token: process.env.GITHUB_MODELS_TOKEN ?? '',
  baseUrl: process.env.JARVIS_AI_BASE_URL ?? 'https://models.github.ai/inference',
  model: process.env.JARVIS_AI_MODEL ?? 'openai/gpt-4o-mini',
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
  // Fatal disconnect: a session takeover (440), a ban (403), or an unrecoverable session (500) stays
  // DOWN (exit 0) - restarting would re-fight or re-hammer. Reconnect exhaustion gets a clean restart
  // (exit non-zero) so a fresh process can retry from scratch.
  onFatal: (reason) => {
    log.error('wa: fatal disconnect', { reason });
    quit(reason === 'exhausted' ? 1 : 0);
  },
  // The bot was removed from a group: deactivate it so Jarvis goes silent there - including stopping
  // its scheduled proactive sends (which deliver outside the inbound activation gate).
  onRemoved: (chatId) => {
    activation.deactivate(chatId);
    const cleared = scheduler.clearChat(chatId);
    if (cleared) log.info('cleared scheduled jobs for a removed group', { chatId, cleared });
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
    log.warn('owner requested a full data wipe (auth kept)');
    setTimeout(() => { store.clearAll(); quit(1); }, 1500); // clear the app db (the auth db is untouched), then restart
  },
};

const app = createApp(adapter, {
  // match is LID-aware so an owner set by phone number matches a LID sender.
  handle: createDispatcher(registry, {
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
    // Canonicalize a named person for the access lists: a JID (e.g. from an @mention)
    // is resolved toward its phone form; a bare number becomes a phone JID. Matching
    // then bridges LID <-> phone, so a person named one way matches a sender on the other.
    resolveUser: (token) => {
      const t = String(token ?? '').trim();
      if (!t) return t;
      if (t.includes('@')) return identity.resolve(t);
      const digits = t.replace(/[^0-9]/g, '');
      return digits ? identity.resolve(`${digits}@s.whatsapp.net`) : t;
    },
  }),
});

// Proactive output (scheduled messages) runs in the background. Delivery reuses the adapter's
// send, which paces every message through the global spacing limiter, so output never bursts.
// Started before the (blocking) start() so the timer is live; the first tick is after one
// interval, so we never deliver before the socket connects.
const deliver = async (chatId, text) => {
  // Proactive sends must respect the same activation gate as inbound commands: never post into a
  // group the owner has not authorized (or has deactivated, or removed the bot from). A group also
  // counts as active under its community umbrella (a community activated -> all its groups are on).
  // Private chats have no activation entry and are never gated. Off when activation is not required.
  if (requireActivation && isJidGroup(chatId)) {
    const communityId = await adapter.communityOf(chatId);
    if (!activation.isActive(chatId) && !(communityId && activation.isActive(communityId))) {
      log.info('skip scheduled send to an inactive group', { chatId });
      return false; // DECLINE: signal the scheduler this was not delivered, so it leaves the job pending
    }
  }
  return adapter.send(chatId, text);
};
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
