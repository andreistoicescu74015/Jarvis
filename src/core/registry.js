/**
 * A command the bot can run.
 *
 * @typedef {Object} Command
 * @property {string} name                       Unique, lowercase (e.g. 'ping').
 * @property {string} summary                    One line, shown by `help`.
 * @property {string} [usage]                    Optional usage hint.
 * @property {string} [man]                      Optional long-form help, shown by `man`.
 * @property {object} [params]                   Optional parameter schema (seed for AI tools; ADR-0005).
 * @property {import('./scope.js').Scope} [scope] Optional permission requirements.
 * @property {(ctx: import('./dispatch.js').Ctx) => unknown} run
 *
 * @typedef {Object} Registry
 * @property {(name: string) => (Command | undefined)} get
 * @property {(name: string) => boolean} has
 * @property {() => Command[]} all
 */

/**
 * Build a command registry from a list of commands.
 *
 * @param {Command[]} [commands]
 * @returns {Registry}
 */
export function createRegistry(commands = []) {
  const map = new Map();
  for (const cmd of commands) {
    if (!cmd || typeof cmd.name !== 'string' || typeof cmd.run !== 'function') {
      throw new TypeError('registry: each command needs a string `name` and a `run` function');
    }
    if (map.has(cmd.name)) {
      throw new Error(`registry: duplicate command '${cmd.name}'`);
    }
    map.set(cmd.name, cmd);
  }
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    all: () => [...map.values()],
  };
}
