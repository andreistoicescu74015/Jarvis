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
    '"groups deactivate [<id>]" turns it back off. Activation survives restarts.',
  scope: { owner: true },
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

  if (sub === 'activate') {
    return (await ctx.activation.activate(id, ctx.sender))
      ? `Activated Jarvis in ${name}.`
      : `${name} is already active.`;
  }
  return (await ctx.activation.deactivate(id)) ? `Deactivated Jarvis in ${name}.` : `${name} was not active.`;
}

/** List the groups - grouped by community, tagged active/inactive, with link clusters shown. */
async function list(ctx) {
  const groups = ctx.listGroups ? await ctx.listGroups() : [];
  if (!groups.length) return 'No groups found (or not available here).';
  const active = new Set(ctx.activation ? ctx.activation.list() : []);
  const tag = (g) => {
    const state = ctx.activation ? ` ${i(active.has(g.id) ? '(active)' : '(inactive)')}` : '';
    const ann = g.isCommunity ? ` ${i('[community]')}` : '';
    return `${b(esc(g.name))} ${code(esc(g.id))}${state}${ann}`;
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
