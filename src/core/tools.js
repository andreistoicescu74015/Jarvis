import { checkScope } from './scope.js';

/**
 * The bridge between the deterministic command registry and AI tool-use (ADR-0005).
 *
 * `toolCatalog` turns the commands a caller may run (by scope) into OpenAI-style tool
 * definitions, each carrying the command's parameter schema. `toCommandLine` does the
 * inverse: given a command and the arguments the model filled in, it rebuilds the
 * canonical command line (e.g. `whitelist * enable`) - which the dispatcher then parses
 * and runs through every normal guard. The model only proposes; the core authorizes.
 */

/** Build the JSON-Schema `parameters` object for one command's params. */
function toParameters(params = []) {
  const properties = {};
  const required = [];
  for (const p of params) {
    const prop = { type: p.type === 'number' ? 'number' : 'string' };
    if (p.desc) prop.description = p.desc;
    if (p.enum) prop.enum = p.enum;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The commands `scopeCtx` (level / isAdmin / isOwner) may run, as OpenAI tool definitions.
 * Filtering by scope keeps the model from proposing commands the caller would just be
 * refused, and keeps the prompt small - the same filter `help` uses.
 *
 * @param {import('./registry.js').Command[]} commands
 * @param {{ level: string, isAdmin: boolean, isOwner: boolean }} scopeCtx
 * @returns {object[]}
 */
export function toolCatalog(commands, scopeCtx) {
  return commands
    .filter((c) => checkScope(c.scope, scopeCtx).ok)
    .map((c) => ({
      type: 'function',
      function: {
        name: c.name,
        description: c.usage ? `${c.summary} Usage: ${c.usage}` : c.summary,
        parameters: toParameters(c.params),
      },
    }));
}

/**
 * Rebuild the canonical command line from a tool call: the command name followed by each
 * declared param's value, in declaration order (a variadic param is appended verbatim,
 * spaces and all). The result is exactly what a user could have typed, so it goes back
 * through `parse` + every guard. Returns '' for an unknown command; throws if a required
 * param is missing (the planner treats that as a failed translation).
 *
 * @param {import('./registry.js').Command | undefined} command
 * @param {Record<string, unknown>} [args]  The arguments the model supplied.
 * @returns {string}
 */
export function toCommandLine(command, args = {}) {
  if (!command) return '';
  const parts = [command.name];
  for (const p of command.params ?? []) {
    const raw = args?.[p.name];
    const v = raw == null ? '' : String(raw).trim();
    if (!v) {
      if (p.required) throw new Error(`tools: "${command.name}" is missing required arg "${p.name}"`);
      // An omitted OPTIONAL param ends the positional line: a later value cannot fill this gap without
      // shifting into the wrong slot on re-parse. Stop, so e.g. groups({id}) with no action rebuilds as
      // "groups" (a safe list), never "groups <id>" (which would misparse the id as the action).
      break;
    }
    // A NON-VARIADIC param fills exactly one positional slot: a value with whitespace would re-parse
    // as several arguments and shift everything after it, so the command would run with a DIFFERENT
    // meaning than the line echoed to the user. Refuse the proposal instead (a failed translation) -
    // better no command than a different one than shown.
    if (!p.variadic && /\s/.test(v)) {
      throw new Error(`tools: "${command.name}" arg "${p.name}" must be a single token`);
    }
    parts.push(v);
  }
  return parts.join(' ').trim();
}
