import { nullLogger } from '../core/log.js';

/**
 * A minimal pino-compatible logger (Baileys' `ILogger`) backed by our own logger,
 * so we add no logging dependency. Baileys logs very verbosely; we forward only
 * `warn`/`error`/`fatal` to `log` and drop the rest. `child()` returns self and
 * `level` is a plain settable property. It never throws.
 *
 * @param {import('../core/log.js').Logger} [log]
 * @param {string} [level]
 * @returns {any}
 */
export function socketLogger(log = nullLogger, level = 'warn') {
  const text = (o, m) => (typeof o === 'string' ? o : m ?? '');
  const self = {
    level,
    trace() {},
    debug() {},
    info() {},
    warn: (o, m) => log.warn(`wa: ${text(o, m)}`),
    error: (o, m) => log.error(`wa: ${text(o, m)}`),
    fatal: (o, m) => log.error(`wa: ${text(o, m)}`),
    child: () => self,
  };
  return self;
}
