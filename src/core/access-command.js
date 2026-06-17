/**
 * Shared implementation of the owner's `whitelist` / `blacklist` commands. Both are
 * the same UI over the access policy (`ctx.access`), differing only in which list they
 * edit - so the two commands stay thin leaves that import this from the core (never
 * each other). Owner-only; denials and gating live in the dispatcher.
 *
 * Grammar: jarvis <list> [<target>] [<verb> [<person>]] [in <context>]
 *   <target>   a command name, or `*` (the whole bot). Omitted -> overview.
 *   <verb>     add | remove | enable | disable | clear. Omitted (with a target) -> show.
 *   <person>   an @mention, a phone/id, or `*` (everyone). For add / remove.
 *   in <ctx>   `here` (default) | `*` (everywhere) | a chat id.
 */

const VERBS = new Set(['add', 'remove', 'enable', 'disable', 'clear']);

/**
 * Build the descriptor for one list command.
 *
 * @param {'whitelist'|'blacklist'} list
 * @returns {import('./registry.js').Command}
 */
export function makeAccessCommand(list) {
  return {
    name: list,
    summary:
      list === 'whitelist'
        ? 'Owner: limit a command to specific people (allow-list).'
        : 'Owner: block specific people from a command (deny-list).',
    usage: `jarvis ${list} <command|*> add|remove <@user|number|*> | enable | disable | clear [in <chat|*>]`,
    scope: { owner: true },
    run: (ctx) => run(ctx, list),
  };
}

function run(ctx, list) {
  if (!ctx.access) return 'Access lists are unavailable here.';
  const other = list === 'whitelist' ? 'blacklist' : 'whitelist';

  // Peel a trailing "in <context>" off the arguments.
  let args = ctx.args.slice();
  let context = ctx.chatId;
  const at = args.findIndex((a) => a.toLowerCase() === 'in');
  if (at !== -1) {
    const c = args[at + 1];
    if (!c) return usage(list);
    context = c === '*' ? '*' : c.toLowerCase() === 'here' ? ctx.chatId : c;
    args = args.slice(0, at);
  }

  const target = args[0];
  if (!target) return overview(ctx, list);

  const verb = (args[1] ?? '').toLowerCase();
  if (!verb) return show(ctx, list, target, context);
  if (!VERBS.has(verb)) return usage(list);

  // Validate a command target. `*` (whole bot) is always valid; owner-only commands
  // and the bootstrap `owner` command can never be restricted (they would be moot or
  // could lock the bot out).
  if (target !== '*') {
    const cmd = ctx.commands.find((c) => c.name === target);
    if (!cmd) return `No such command: ${target}.`;
    if (target === 'owner') return 'The owner command cannot be restricted (it must stay reachable).';
    if (cmd.scope?.owner) return `${target} is owner-only; access lists do not apply to it.`;
  }

  const at_ = (c) => where(c, ctx);

  switch (verb) {
    case 'enable': {
      const prior = ctx.access.get(target, context).active;
      ctx.access.enable(list, target, context);
      const switched = prior === other ? ` (replaces the ${other})` : '';
      return `Turned on the ${list} for ${label(target)}${at_(context)}${switched}.`;
    }
    case 'disable': {
      if (ctx.access.get(target, context).active !== list) {
        return `The ${list} for ${label(target)}${at_(context)} is not on.`;
      }
      ctx.access.disable(target, context);
      return `Turned off the ${list} for ${label(target)}${at_(context)} (members kept).`;
    }
    case 'clear': {
      ctx.access.clear(list, target, context);
      return `Cleared the ${list} for ${label(target)}${at_(context)}.`;
    }
    case 'add':
    case 'remove': {
      const person = resolvePerson(ctx, args.slice(2));
      if (!person) return usage(list);
      ctx.access[verb](list, target, context, person);
      if (verb === 'remove') {
        return `Removed ${display(person)} from the ${list} for ${label(target)}${at_(context)}.`;
      }
      const note =
        ctx.access.get(target, context).active === list
          ? ''
          : ` (run "jarvis ${list} ${target} enable" to apply)`;
      return `Added ${display(person)} to the ${list} for ${label(target)}${at_(context)}${note}.`;
    }
    default:
      return usage(list);
  }
}

/** Resolve the person being named: `*`, an @mention (preferred), or a typed id/number. */
function resolvePerson(ctx, tokens) {
  if (tokens[0] === '*') return '*';
  const raw = ctx.mentions?.length ? ctx.mentions[0] : tokens[0];
  if (!raw) return '';
  return ctx.resolveUser ? ctx.resolveUser(raw) : String(raw);
}

function overview(ctx, list) {
  const rules = ctx.access.all().filter((r) => r[list].length || r.active === list);
  if (!rules.length) return `No ${list} rules.`;
  const lines = rules.map((r) => {
    const on = r.active === list ? 'on' : 'off';
    const who = r[list].length ? r[list].map(display).join(', ') : '(empty)';
    return `- ${label(r.target)}${where(r.context, ctx)} [${on}]: ${who}`;
  });
  return [`${list} rules:`, ...lines].join('\n');
}

function show(ctx, list, target, context) {
  const rec = ctx.access.get(target, context);
  const on = rec.active === list ? 'on' : 'off';
  const who = rec[list].length ? rec[list].map(display).join(', ') : '(empty)';
  return `${list} for ${label(target)}${where(context, ctx)}: ${on}; ${who}.`;
}

const usage = (list) => `Usage: ${makeAccessCommand(list).usage}`;
const label = (target) => (target === '*' ? 'the whole bot' : `"${target}"`);
const display = (person) => (person === '*' ? 'everyone' : person);
const where = (context, ctx) =>
  context === '*' ? ' everywhere' : context === ctx.chatId ? '' : ` in ${context}`;
