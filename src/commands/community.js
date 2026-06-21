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
  summary: 'Show a community, or activate/deactivate Jarvis across all its groups.',
  usage: 'jarvis community | community activate [<id>] | community deactivate [<id>]',
  man:
    'Show a WhatsApp community: its linked sub-groups with member counts, the total reach, and ' +
    'whether Jarvis is active across it. "community activate [<id>]" turns Jarvis on for the whole ' +
    'community at once - every group in it (including ones added later) passes the silence gate; ' +
    '"community deactivate [<id>]" reverses it, but groups you activated individually stay on. Run ' +
    'it inside the community (or one of its groups), or name it by id (from "jarvis groups"). ' +
    'Activating a community does not change any group\'s access lists.',
  scope: { ownerOrAdmin: true },
  requires: ['community'],
  run: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'activate' || sub === 'deactivate') return manage(ctx, sub);
    return show(ctx);
  },
};

/** Activate/deactivate Jarvis across a whole community - owner-only (the umbrella gate). */
async function manage(ctx, sub) {
  if (!ctx.isOwner) return `Only the owner can ${sub} a community.`;
  if (!ctx.activation) return 'Activation is unavailable here.';
  const id = (ctx.args[1] ?? '').trim() || ctx.communityId;
  if (!id) {
    return `Run this inside a community, or name it: ${code(`jarvis community ${sub} <id>`)} (ids from ${code('jarvis groups')}).`;
  }
  const info = await ctx.community.info(id);
  if (!info) return `No community found for ${code(esc(id))} (ids from ${code('jarvis groups')}).`;
  const name = b(esc(info.name));
  const n = info.subGroups.length;
  if (sub === 'activate') {
    return ctx.activation.activateCommunity(id, ctx.sender)
      ? `Activated Jarvis across ${name} - its ${n} group${n === 1 ? '' : 's'} are now on.`
      : `${name} is already active.`;
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
