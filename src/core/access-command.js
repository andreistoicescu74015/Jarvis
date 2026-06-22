import { accessContextFor } from './access.js';

/**
 * Shared implementation of the `whitelist` / `blacklist` commands. Both are the same UI
 * over the access policy (`ctx.access`), differing only in which list they edit - so the
 * two commands stay thin leaves that import this from the core (never each other).
 *
 * Authority (ADR-0008): the owner manages Jarvis's private context (from a DM) or the current
 * group's context (from that group); a group/community admin manages their own group's context.
 * A rule ALWAYS applies to the current context - there is no "manage another chat" specifier (it
 * was a footgun: easy to edit the wrong context from the wrong place, and a data-leak risk). The
 * scope (`ownerOrAdmin`) lets an admin in; denials and gating live in the dispatcher.
 *
 * Grammar: jarvis <list> [<target>] [<verb> [<person>]]
 *   <target>   a command name, or `*` (the whole bot). Omitted -> overview (this context).
 *   <verb>     add | remove | enable | disable | clear. Omitted (with a target) -> show.
 *   <person>   an @mention, a phone/id, or `*` (everyone). For add / remove.
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
        ? 'Allow-list a command for specific people (this chat).'
        : 'Block specific people from a command (this chat).',
    usage: `jarvis ${list} | ${list} <command|*> add|remove <@user|number|*> | enable | disable | clear`,
    man:
      `Manage the ${list} for a command - or the whole bot (*) - in THIS chat (your DM with Jarvis, ` +
      `or this group). Run "jarvis ${list}" with no command (or "${list} list") to see the current rules. ` +
      `Verbs: add/remove <person>, enable, disable, clear. A person is an @mention, ` +
      `a phone number, or * (everyone). Whitelist and blacklist are exclusive per target; the owner ` +
      `is never affected; the owner command cannot be restricted, and the bot cannot be added.`,
    scope: { ownerOrAdmin: true },
    requires: ['access'],
    params: [
      { name: 'target', desc: 'a command name, or * for the whole bot; omit (or "list") to show the current rules' },
      { name: 'verb', enum: ['add', 'remove', 'enable', 'disable', 'clear'], desc: 'the action' },
      { name: 'person', desc: '@mention, phone number, or * for everyone (for add/remove)' },
    ],
    run: (ctx) => run(ctx, list),
  };
}

function run(ctx, list) {
  const other = list === 'whitelist' ? 'blacklist' : 'whitelist';
  const context = accessContextFor(ctx.level, ctx.chatId); // always the current context

  const target = (ctx.args[0] ?? '').toLowerCase(); // command names are lowercase; match case-insensitively
  // No target - or an explicit "list"/"show"/"rules" word - gives the overview of THIS context's rules.
  // Accepting the words too means both a person and the AI translator land on the overview naturally (the
  // model reaches for "<list> list" for "what is active here"); none is a real command, so nothing is shadowed.
  if (!target || target === 'list' || target === 'show' || target === 'rules') return overview(ctx, list, context);

  // Validate the target (a command name, or * for the whole bot) up front - before a show OR an action.
  // Otherwise a non-command target like "enable" (a user, or the AI translator, that dropped the command
  // name - e.g. "blacklist enable") would silently show an empty rule for something that is not a command.
  // `*` is always valid; owner-only commands and the bootstrap `owner` command can never be restricted.
  if (target !== '*') {
    const cmd = ctx.commands.find((c) => c.name === target);
    if (!cmd) return `No such command: ${target}.`;
    if (target === 'owner') return 'The owner command cannot be restricted (it must stay reachable).';
    if (cmd.scope?.owner) return `${target} is owner-only; access lists do not apply to it.`;
  }

  const verb = (ctx.args[1] ?? '').toLowerCase();
  if (!verb) return show(ctx, list, target, context);
  if (!VERBS.has(verb)) return usage(list);

  switch (verb) {
    case 'enable': {
      const prior = ctx.access.get(target, context).active;
      ctx.access.enable(list, target, context);
      const switched = prior === other ? ` (replaces the ${other})` : '';
      return `Turned on the ${list} for ${label(target)}${switched}.`;
    }
    case 'disable': {
      if (ctx.access.get(target, context).active !== list) {
        return `The ${list} for ${label(target)} is not on.`;
      }
      ctx.access.disable(target, context);
      return `Turned off the ${list} for ${label(target)} (members kept).`;
    }
    case 'clear': {
      ctx.access.clear(list, target, context);
      return `Cleared the ${list} for ${label(target)}.`;
    }
    case 'add':
    case 'remove': {
      const person = resolvePerson(ctx, ctx.args.slice(2));
      if (!person) return usage(list);
      if (verb === 'add' && person !== '*' && ctx.isSelf?.(person)) {
        return 'You cannot add the bot to a list.';
      }
      ctx.access[verb](list, target, context, person);
      if (verb === 'remove') {
        return `Removed ${display(person)} from the ${list} for ${label(target)}.`;
      }
      const note =
        ctx.access.get(target, context).active === list
          ? ''
          : ` (run "jarvis ${list} ${target} enable" to apply)`;
      return `Added ${display(person)} to the ${list} for ${label(target)}${note}.`;
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

/** Every rule in THIS context (cross-context rules are not shown - they cannot be set from here). */
function overview(ctx, list, context) {
  const rules = ctx.access.all().filter((r) => r.context === context && (r[list].length || r.active === list));
  if (!rules.length) return `No ${list} rules here.`;
  const lines = rules.map((r) => {
    const on = r.active === list ? 'on' : 'off';
    const who = r[list].length ? r[list].map(display).join(', ') : '(empty)';
    return `- ${label(r.target)} [${on}]: ${who}`;
  });
  return [`${list} rules here:`, ...lines].join('\n');
}

function show(ctx, list, target, context) {
  const rec = ctx.access.get(target, context);
  const on = rec.active === list ? 'on' : 'off';
  const who = rec[list].length ? rec[list].map(display).join(', ') : '(empty)';
  return `${list} for ${label(target)}: ${on}; ${who}.`;
}

const usage = (list) => `Usage: ${makeAccessCommand(list).usage}`;
const label = (target) => (target === '*' ? 'the whole bot' : `"${target}"`);
const display = (person) => (person === '*' ? 'everyone' : String(person).split('@')[0]);
