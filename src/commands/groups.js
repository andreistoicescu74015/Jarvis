import { b, i, code, bullet, page, esc } from '../core/format.js';

const PAGE = 30; // groups shown by one listing, so a bot in many chats still produces a readable message

/**
 * Resolve what the owner typed to exactly one group: its id, or its NAME. The id is what WhatsApp
 * uses and what nobody can retype from a phone (`120363041234567890@g.us`), so a name - or a
 * distinctive part of one - is accepted too, matched case-insensitively. An ambiguous name is
 * REFUSED rather than guessed: the same argument also drives `deactivate`, and hitting the wrong
 * group there tears it down.
 *
 * @returns {{ ok: true, group: object } | { ok: false, message: string }}
 */
function findGroup(arg, known) {
  const byId = known.find((g) => g.id === arg);
  if (byId) return { ok: true, group: byId };
  // Without the membership list nothing can be verified, and a community id given plain-group
  // semantics would announce into the community or tear it down. Refuse instead of guessing.
  if (!known.length) {
    return {
      ok: false,
      message: `I can't fetch the group list right now, so I can't check which group that is - try again in a moment, or run the command inside the group itself.`,
    };
  }
  const q = arg.toLowerCase();
  const exact = known.filter((g) => String(g.name).toLowerCase() === q);
  const hits = exact.length ? exact : known.filter((g) => String(g.name).toLowerCase().includes(q));
  if (hits.length === 1) return { ok: true, group: hits[0] };
  if (!hits.length) return { ok: false, message: `I'm not in a group called ${code(esc(arg))} (see ${code('jarvis groups')}).` };
  return {
    ok: false,
    message: `${code(esc(arg))} fits ${hits.length} groups: ${hits.slice(0, 5).map((g) => b(esc(g.name))).join(', ')}. Use the full name.`,
  };
}

/**
 * Owner-only: list and authorize the groups Jarvis runs in (ADR-0008). `jarvis groups`
 * lists every group the bot is a member of, each with its id and whether Jarvis is active
 * there. A group is inactive (the bot stays silent) until the owner activates it:
 * `jarvis groups activate` turns on the current group, `jarvis groups activate <name>` one
 * named by its name (or its id); `deactivate` reverses it. The platform supplies the
 * membership list via `ctx.listGroups`; off a group platform it is empty.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'groups',
  summary: 'Owner: list and activate/deactivate the groups the bot runs in.',
  usage: 'jarvis groups | groups activate [<name>] | groups deactivate [<name>]',
  man:
    'List the groups Jarvis is in, with their ids and whether the bot is active in each.\n' +
    'Jarvis stays silent in a group until you activate it.\n' +
    `${code('jarvis groups activate')} turns on the group you are in.\n` +
    `${code('jarvis groups activate <name>')} turns on another one - the name from the list (a ` +
    'distinctive part of it is enough); the id works too. An ambiguous name is refused, never guessed.\n' +
    `${code('jarvis groups deactivate [<name>]')} turns it back off and clears what that chat held.\n` +
    'Naming a COMMUNITY switches its whole umbrella instead: gate-only, confirmed here, with nothing ' +
    'posted to the community. A sub-group that stays on via that umbrella is re-locked to admins only.\n' +
    'Naming a group needs the group list to be reachable; activation survives restarts.',
  scope: { owner: true },
  // On a plain group, `deactivate` is a full reset (its access lists, AI opt-in, links, schedules, and
  // data are wiped); on a community id it is the gate-only umbrella toggle. Either way it silences
  // chats - destructive, so the AI translator never auto-runs it from a guess (owner must type it).
  confirm: (args) => (args[0] ?? '').toLowerCase() === 'deactivate',
  params: [
    { name: 'action', enum: ['activate', 'deactivate'], desc: 'turn the bot on/off in a group, or omit to list groups' },
    // Variadic, and last: a group NAME has spaces ("Anul 3 Info"), and a non-variadic argument is
    // refused by the tool bridge for containing one - so the model could name only single-word groups
    // while a typed command handled any of them.
    { name: 'id', desc: 'the group name or id (omit for the current group)', variadic: true },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'activate' || sub === 'deactivate') return manage(ctx, sub);
    return list(ctx);
  },
};

/** Turn activation on/off for the current chat (no argument) or one named by its name or id. */
async function manage(ctx, sub) {
  if (!ctx.activation) return 'Activation is unavailable here.';
  // Everything after the verb is the target, so a group NAME with spaces reads naturally.
  const arg = ctx.args.slice(1).join(' ').trim();
  const known = ctx.listGroups ? await ctx.listGroups() : [];
  let match;
  if (arg) {
    const found = findGroup(arg, known);
    if (!found.ok) return found.message;
    match = found.group;
  }
  const id = match ? match.id : ctx.level !== 'private' ? ctx.chatId : '';
  if (!id) {
    return `Run this in the group, or name it: ${code(`jarvis groups ${sub} <name>`)} (names from ${code('jarvis groups')}).`;
  }
  if (!match) match = known.find((g) => g.id === id); // the in-chat form: look the current chat up for its name
  const name = match ? b(esc(match.name)) : code(esc(id));
  // The target's parent community, when known: umbrella-aware replies + the deactivation re-lock.
  const parent = arg ? match?.community : ctx.communityId;

  // A COMMUNITY id gets community semantics: the gate-only umbrella, confirmed HERE - never a bulk
  // announcement or an access reset pushed into the announcement group (no unsolicited sends;
  // ban-safety). Recognized from the membership list, or by being run in the announcement chat
  // itself (whose own id IS the community id).
  const isCommunity = match ? !!match.isCommunity : !arg && ctx.level === 'community' && ctx.communityId === ctx.chatId;
  if (isCommunity) {
    if (sub === 'activate') {
      return ctx.activation.activateCommunity(id, ctx.sender)
        ? `Activated Jarvis across the ${name} community - its groups are on. Nothing was posted to them.`
        : `${name} is already active.`;
    }
    return ctx.activation.deactivateCommunity(id)
      ? `Deactivated Jarvis across the ${name} community. Groups you activated individually stay on.`
      : `${name} was not active.`;
  }

  if (sub === 'activate') {
    return (await ctx.activation.activate(id, ctx.sender))
      ? `Activated Jarvis in ${name}.`
      : `${name} is already active.`;
  }
  if (await ctx.activation.deactivate(id, parent)) {
    // Deactivated its own entry - but a live community umbrella keeps the bot answering there. Say
    // so (a bare "Deactivated" would be a lie), and note the dispatcher re-locked it to admins only
    // (its curated lists were reset by the teardown; a live chat must not silently open to everyone).
    if (parent && parent !== id && ctx.activation.isActive(parent)) {
      return `Removed ${name}'s own activation - but it stays ${b('active via its community umbrella')} (re-locked to admins only). ${code(`jarvis community deactivate ${parent}`)} turns the whole community off.`;
    }
    return `Deactivated Jarvis in ${name}.`;
  }
  // Not individually active - but running under a community umbrella? Say so instead of a misleading
  // "was not active": the switch to flip is at the community level.
  if (parent && parent !== id && ctx.activation.isActive(parent)) {
    return `${name} has no individual activation - it is active via its community umbrella. ${code(`jarvis community deactivate ${parent}`)} turns the whole community off.`;
  }
  return `${name} was not active.`;
}

/** List the groups - grouped by community, tagged active/inactive, with link clusters shown. */
async function list(ctx) {
  const groups = ctx.listGroups ? await ctx.listGroups() : [];
  if (!groups.length) return 'No groups found (or not available here).';
  const active = new Set(ctx.activation ? ctx.activation.list() : []);
  const tag = (g) => {
    const size = Number.isFinite(g.size) ? ` ${i(`(${g.size})`)}` : '';
    let state = '';
    if (ctx.activation) {
      // Effective activation: a sub-group is on if its own id is active OR its community is (umbrella).
      const ownActive = active.has(g.id);
      const viaCommunity = !ownActive && g.community && active.has(g.community);
      state = ` ${i(ownActive ? '(active)' : viaCommunity ? '(active via community)' : '(inactive)')}`;
    }
    const ann = g.isCommunity ? ` ${i('[community]')}` : '';
    return `${b(esc(g.name))} ${code(esc(g.id))}${size}${state}${ann}`;
  };
  // Split standalone groups from community members (a sub-group's `community` is its parent's id).
  const sorted = groups.slice().sort((a, b2) => String(a.name).localeCompare(String(b2.name)));
  const { shown, hidden } = page(sorted, { limit: PAGE }); // a bot in many groups still gets a readable list
  const standalone = [];
  const byCommunity = new Map();
  for (const g of shown) {
    if (!g.community) standalone.push(g);
    else (byCommunity.get(g.community) ?? byCommunity.set(g.community, []).get(g.community)).push(g);
  }
  const out = [`${b('Groups')} ${i(`(${groups.length})`)}`];
  if (standalone.length) out.push(bullet(standalone.map(tag)));
  for (const [cid, members] of byCommunity) {
    const name = groups.find((g) => g.id === cid && g.isCommunity)?.name;
    out.push(`${b('Community')}${name ? ` ${esc(name)}` : ''}:`, bullet(members.map(tag)));
  }
  // Groups sharing one link overlay - shown by name so it is clear which have a joint context.
  const nameOf = (id) => groups.find((g) => g.id === id)?.name ?? id;
  const clusters = (ctx.links?.clusters?.() ?? []).filter((c) => c.length > 1);
  if (clusters.length) {
    out.push(`${b('Linked together')}:`, bullet(clusters.map((c) => c.map((id) => esc(nameOf(id))).join(' + '))));
  }
  if (hidden) out.push(i(`Showing ${shown.length} of ${groups.length}, alphabetically.`));
  return out.join('\n');
}
