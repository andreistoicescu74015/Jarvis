import { b, i, code, bullet, esc } from '../core/format.js';

/**
 * Show or authorize a WhatsApp community. `jarvis community` shows the current
 * community's structure (sub-groups, member counts, reach) and whether Jarvis is
 * active across it. `jarvis community activate [<id>]` turns Jarvis on for the WHOLE
 * community at once - the silence gate opens for every group in it (including ones
 * added later); `deactivate` reverses it (groups activated individually stay on).
 * Run it inside the community (or one of its groups), or name it by id (from
 * `jarvis groups`). Off WhatsApp the capability is absent, so it reports unavailable.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'community',
  summary: 'Owner: show a community, or activate/deactivate Jarvis across all its groups.',
  usage: 'jarvis community | community activate [<id>] | community deactivate [<id>]',
  man:
    'Show a WhatsApp community: its linked sub-groups with member counts, the total reach, and ' +
    'whether Jarvis is active across it. "community activate [<id>]" turns Jarvis on for the whole ' +
    'community at once - every group in it (including ones added later) passes the silence gate; ' +
    '"community deactivate [<id>]" reverses it, but groups you activated individually stay on. Run ' +
    'it inside the community (or one of its groups), or name it by id (from "jarvis groups"). ' +
    'Activating a community does not change any group\'s access lists.',
  scope: { owner: true },
  requires: ['community'],
  params: [
    { name: 'action', enum: ['activate', 'deactivate'], desc: 'turn the bot on/off across a whole community, or omit to show it' },
    { name: 'id', desc: 'the community id (omit for the current one)' },
  ],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'activate' || sub === 'deactivate') return manage(ctx, sub);
    return show(ctx);
  },
};

/** Activate/deactivate Jarvis across a whole community (the command is owner-only; the umbrella gate). */
async function manage(ctx, sub) {
  if (!ctx.activation) return 'Activation is unavailable here.';
  const arg = (ctx.args[1] ?? '').trim();
  const id = arg || ctx.communityId;
  if (!id) {
    return `Run this inside a community, or name it: ${code(`jarvis community ${sub} <id>`)} (ids from ${code('jarvis groups')}).`;
  }
  // A NAMED id is validated against the communities the bot is actually in (when that read works): a
  // typo must not "activate" a phantom id behind a confident confirmation. Best-effort like `groups`
  // validates against its list - an empty or failed listing never blocks the local KV write. The two
  // reads (the validation list and the confirmation enrichment) are independent network calls, so
  // they run in parallel - the owner waits for the slower one, not the sum.
  const [knownCommunities, info] = await Promise.all([
    arg ? ctx.community.all() : Promise.resolve([]),
    ctx.community.info(id),
  ]);
  if (arg && knownCommunities.length && !knownCommunities.some((c) => c.id === id)) {
    return `No such community: ${code(esc(id))} (ids from ${code('jarvis groups')}).`;
  }
  // Activation is a local KV write - never block it on the (network, best-effort) community read.
  // The read only enriches the confirmation with the name + group count when it is available.
  const name = info ? b(esc(info.name)) : code(esc(id));
  if (sub === 'activate') {
    if (!ctx.activation.activateCommunity(id, ctx.sender)) return `${name} is already active.`;
    const n = info?.subGroups.length;
    return n != null
      ? `Activated Jarvis across ${name} - its ${n} group${n === 1 ? '' : 's'} are now on.`
      : `Activated Jarvis across ${name}.`;
  }
  return ctx.activation.deactivateCommunity(id)
    ? `Deactivated Jarvis across ${name}. Groups you activated individually stay on.`
    : `${name} was not active.`;
}

/** Show the community structure, tagged with whether Jarvis is active across it and per sub-group. */
async function show(ctx) {
  const id = (ctx.args[0] ?? '').trim();
  const info = await ctx.community.info(id || undefined);
  if (!info) {
    return id
      ? `No community found for ${code(esc(id))} (ids from ${code('jarvis groups')}).`
      : `Run this inside a community, or name one: ${code('jarvis community <id>')} (ids from ${code('jarvis groups')}).`;
  }
  const umbrella = ctx.activation ? ctx.activation.isActive(info.id) : false;
  const active = new Set(ctx.activation ? ctx.activation.list() : []);
  const reach = info.reach ? ` ${i(`(${info.reach} members)`)}` : '';
  const state = ctx.activation ? ` ${i(umbrella ? '(active)' : '(inactive)')}` : '';
  const out = [`${b('Community')} ${esc(info.name)}${reach}${state}`];
  if (info.description) out.push(esc(info.description));
  if (info.subGroups.length) {
    out.push(
      `${b('Groups')} ${i(`(${info.subGroups.length})`)}:`,
      bullet(
        info.subGroups.map((g) => {
          const size = Number.isFinite(g.size) ? ` ${i(`(${g.size})`)}` : '';
          const on = ctx.activation ? ` ${i(umbrella || active.has(g.id) ? '(on)' : '(off)')}` : '';
          return `${esc(g.name)}${size}${on}`;
        }),
      ),
    );
  } else {
    out.push(i('No linked sub-groups.'));
  }
  return out.join('\n');
}
