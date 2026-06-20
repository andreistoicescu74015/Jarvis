import { nullLogger } from '../core/log.js';

// Right after a FRESH pairing, Baileys (v7-rc) cannot sync the account's app-state collections yet -
// it logs "<collection> blocked on missing key from v0, parking after N attempts" for each of them -
// and it ignores an online presence while the account is still unnamed. None of this stops a COMMAND
// bot: inbound messages arrive over a separate channel (messages.upsert), group metadata is fetched
// on demand, and sending works. So these known-harmless, alarming-looking warnings are demoted to
// debug instead of surfacing as warnings; a genuinely new warning still comes through untouched.
const HARMLESS_WARN = [
  /missing key from v0/i, // app-state sync key not available yet, then it gives up ("parking")
  /ignoring presence update/i, // presence ignored while the account has no profile name
];

/**
 * A minimal pino-compatible logger (Baileys' `ILogger`) backed by our own logger,
 * so we add no logging dependency. Baileys logs very verbosely; we forward only
 * `warn`/`error`/`fatal` to `log` and drop the rest (harmless app-state-sync warnings
 * are demoted to `debug`). `child()` returns self and `level` is a plain settable
 * property. It never throws.
 *
 * @param {import('../core/log.js').Logger} [log]
 * @param {string} [level]
 * @returns {any}
 */
export function socketLogger(log = nullLogger, level = 'warn') {
  const text = (o, m) => (typeof o === 'string' ? o : m ?? '');
  const harmless = (s) => HARMLESS_WARN.some((re) => re.test(s));
  const self = {
    level,
    trace() {},
    debug() {},
    info() {},
    warn: (o, m) => {
      const msg = text(o, m);
      if (harmless(msg)) log.debug(`wa: ${msg}`);
      else log.warn(`wa: ${msg}`);
    },
    error: (o, m) => log.error(`wa: ${text(o, m)}`),
    fatal: (o, m) => log.error(`wa: ${text(o, m)}`),
    child: () => self,
  };
  return self;
}
