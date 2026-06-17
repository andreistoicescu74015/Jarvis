/**
 * Owner-only: list the groups Jarvis is a member of, each with its id, so the owner
 * can target a group remotely (e.g. `jarvis blacklist note add @user in <id>`). The
 * platform supplies the list via `ctx.listGroups`; off a group platform it is empty.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'groups',
  summary: 'Owner: list the groups the bot is in (with their ids).',
  usage: 'jarvis groups',
  man:
    'List the groups Jarvis is a member of, each with its id. Copy an id to target a group ' +
    'you are not in - e.g. "jarvis blacklist note add @user in <id>".',
  scope: { owner: true },
  run: async (ctx) => {
    const groups = ctx.listGroups ? await ctx.listGroups() : [];
    if (!groups.length) return 'No groups found (or not available here).';
    const lines = groups
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((g) => `- ${g.name} - ${g.id}`);
    return [`Groups (${groups.length}):`, ...lines].join('\n');
  },
};
