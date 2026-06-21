/**
 * One declared parameter of a command - the bridge to AI tool-use (ADR-0005). Order matters:
 * rebuilding a command line appends each value in declaration order, so optional and variadic
 * params come last. From this we both generate the tool's JSON-Schema (for the model to fill) and
 * reconstruct the canonical command the deterministic dispatcher then runs - so AI never bypasses
 * a guard, it only proposes the command.
 *
 * @typedef {Object} Param
 * @property {string} name              Argument name (the tool property key).
 * @property {'string'|'number'} [type] Value type (default 'string').
 * @property {string[]} [enum]          Allowed values, for closed sets (verbs, actions).
 * @property {boolean} [required]       The model must supply it.
 * @property {boolean} [variadic]       Free trailing text that may contain spaces (must be the last param).
 * @property {string} desc             What it is - shown to the model.
 */

/**
 * A command the bot can run.
 *
 * @typedef {Object} Command
 * @property {string} name                       Unique, lowercase (e.g. 'ping').
 * @property {string} summary                    One line, shown by `help`.
 * @property {string} [usage]                    Optional usage hint.
 * @property {string} [man]                      Optional long-form help, shown by `man`.
 * @property {Param[]} [params]                  Ordered parameter schema - the AI-tools bridge (ADR-0005); see Param above.
 * @property {string[]} [requires]               ctx capabilities the command needs (e.g. ['store']); the dispatcher reports it unavailable when one is missing.
 * @property {boolean} [confirm]                 Destructive: the AI translator never auto-runs it - the user must type it (typing is the confirmation).
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
