/**
 * Minimal structured logger seam (the "Observability" capability from the core
 * design). Console-backed and level-filtered; it writes to **stderr** so logs
 * never mix with chat output (CLI replies go to stdout). The shape is small on
 * purpose - a richer logger (e.g. pino, needed by the WhatsApp adapter) can be
 * injected later without touching callers.
 *
 * @typedef {(message: string, fields?: Record<string, unknown>) => void} LogFn
 * @typedef {Object} Logger
 * @property {LogFn} debug
 * @property {LogFn} info
 * @property {LogFn} warn
 * @property {LogFn} error
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Build a logger. Messages below `level` are dropped. Each line is
 * `<iso> [<level>] <message> {<fields>}`.
 *
 * @param {{ level?: keyof typeof LEVELS, sink?: (line: string) => void }} [opts]
 * @returns {Logger}
 */
export function createLogger({ level = 'info', sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((line) => process.stderr.write(`${line}\n`));

  const at = (name) => (message, fields) => {
    if (LEVELS[name] < threshold) return;
    const head = `${new Date().toISOString()} [${name}] ${message}`;
    write(fields ? `${head} ${JSON.stringify(fields)}` : head);
  };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A logger that swallows everything - the default when none is injected (tests, quiet runs). */
export const nullLogger = /** @type {Logger} */ ({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
