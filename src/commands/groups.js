import { b, i, code, bullet, esc } from '../core/format.js';

/**
 * Owner-only: list and authorize the groups Jarvis runs in (ADR-0008). `jarvis groups`
 * lists every group the bot is a member of, each with its id and whether Jarvis is active
 * there. A group is inactive (the bot stays silent) until the owner activates it:
 * `jarvis groups activate` turns on the current group, `jarvis groups activate <id>` one
 * named by id (copy it from the list); `deactivate` reverses it. The platform supplies the
 * membership list via `ctx.listGroups`; off a group platform it is empty.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'groups',
  summary: 'Owner: list and activate/deactivate the groups the bot runs in.',
  usage: 'jarvis groups | groups activate [<id>] | groups deactivate [<id>]',
  man:
    'List the groups Jarvis is a member of, each with its id and whether the bot is active ' +
    'there. Jarvis stays silent in a group until you activate it. "groups activate" turns on ' +
    'the current group; "groups activate <id>" one named by id (copy it from the list); ' +
    '"groups deactivate [<id>]" turns it back off. A COMMUNITY id gets the umbrella instead: ' +
    'gate-only, confirmed here, with nothing posted to the community (same as "community ' +
    'activate"). Activation survives restarts.',
  scope: { owner: true },
  // `deactivate` is a full reset of the group (its access lists, AI opt-in, links, schedules, and
  // data are wiped) - destructive, so the AI translator never auto-runs it from a guess (owner must type it).
  confirm: (args) => (args[0] ?? '').toLowerCase() === 'deactivate',
  params: [
    { name: 'action', enum: ['activate', 'deactivate'], desc: 'turn the bot on/off in a group, or omit to list groups' },
    { name: 'id', desc: 'the group id (omit for the current group)' },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'activate' || sub === 'deactivate') return manage(ctx, sub);
    return list(ctx);
  },
};

/** Turn activation on/off for the current chat (no id) or a chat named by id. */
async function manage(ctx, sub) {
  if (!ctx.activation) return 'Activation is unavailable here.';
  const arg = (ctx.args[1] ?? '').trim();
  const id = arg || (ctx.level !== 'private' ? ctx.chatId : '');
  if (!id) {
    return `Run this in the group, or name it: ${code(`jarvis groups ${sub} <id>`)} (ids from ${code('jarvis groups')}).`;
  }
  // When the membership list is available, validate a named id and resolve a display name.
  const known = ctx.listGroups ? await ctx.listGroups() : [];
  const match = known.find((g) => g.id === id);
  if (arg && known.length && !match) return `No such group: ${code(esc(id))} (see ${code('jarvis groups')}).`;
  const name = match ? b(esc(match.name)) : code(esc(id));

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
  if (await ctx.activation.deactivate(id)) return `Deactivated Jarvis in ${name}.`;
  // Not individually active - but running under a community umbrella? Say so instead of a misleading
  // "was not active": the switch to flip is at the community level.
  const parent = arg ? match?.community : ctx.communityId;
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
  const standalone = [];
  const byCommunity = new Map();
  for (const g of sorted) {
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
  return out.join('\n');
}
