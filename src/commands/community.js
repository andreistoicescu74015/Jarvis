import { b, i, code, bullet, esc } from '../core/format.js';

/**
 * Show a WhatsApp community's structure: its name, description, linked sub-groups
 * with their member counts, and the total reach. Read-only - it never changes the
 * community. Run it inside a community (or one of its groups) to show the current
 * one, or name it by id: `jarvis community <id>` (ids come from `jarvis groups`).
 * Off a WhatsApp platform (e.g. the CLI) the capability is absent, so the command
 * reports unavailable via `requires`.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'community',
  summary: 'Show a community: its sub-groups, member counts, and reach.',
  usage: 'jarvis community [<id>]',
  man:
    'Show the structure of a WhatsApp community: its linked sub-groups with member counts ' +
    'and the total reach. Run it inside the community (or one of its groups) to show the ' +
    'current one, or name it by id: "jarvis community <id>" (ids from "jarvis groups"). ' +
    'Read-only - it never changes the community.',
  scope: { ownerOrAdmin: true },
  requires: ['community'],
  run: async (ctx) => {
    const id = (ctx.args[0] ?? '').trim();
    const info = await ctx.community.info(id || undefined);
    if (!info) {
      return id
        ? `No community found for ${code(esc(id))} (ids from ${code('jarvis groups')}).`
        : `Run this inside a community, or name one: ${code('jarvis community <id>')} (ids from ${code('jarvis groups')}).`;
    }
    const out = [`${b('Community')} ${esc(info.name)}${info.reach ? ` ${i(`(${info.reach} members)`)}` : ''}`];
    if (info.description) out.push(esc(info.description));
    if (info.subGroups.length) {
      out.push(
        `${b('Groups')} ${i(`(${info.subGroups.length})`)}:`,
        bullet(info.subGroups.map((g) => `${esc(g.name)}${Number.isFinite(g.size) ? ` ${i(`(${g.size})`)}` : ''}`)),
      );
    } else {
      out.push(i('No linked sub-groups.'));
    }
    return out.join('\n');
  },
};
