import { b, code, bullet, esc } from '../core/format.js';

/**
 * Owner/admin: keyword auto-replies for this chat. "jarvis rule add <keyword> <reply...>" makes Jarvis
 * post <reply> whenever someone addresses it with that keyword (e.g. "jarvis menu"). Deterministic - no
 * AI, no tokens - and checked AFTER real commands and aliases, so a rule never shadows them. Per-chat.
 * The reply may use the whitelisted placeholders {{sender}} and {{chat}}; it is NOT a template language.
 *
 * @type {import('../core/registry.js').Command}
 */
export default {
  name: 'rule',
  summary: 'Owner/admin: keyword auto-replies for this chat.',
  usage: 'jarvis rule add <keyword> <reply...> | list | remove <keyword>',
  man:
    'Keyword auto-replies, scoped to this chat. "rule add menu Today: soup and bread" makes "jarvis ' +
    'menu" reply with that text - deterministically, with no AI. A keyword is a single word and is ' +
    'checked after real commands and aliases (so it cannot shadow them). The reply may use {{sender}} ' +
    'and {{chat}} as placeholders. "rule list" (or "rule" alone) shows them; "rule remove <keyword>" ' +
    'deletes one. Owner anywhere, or a group admin in their group.',
  scope: { ownerOrAdmin: true },
  requires: ['rules'],
  params: [
    { name: 'action', enum: ['add', 'list', 'remove'], required: true, desc: 'add a keyword auto-reply, list them, or remove one' },
    { name: 'rest', variadic: true, desc: 'for "add" it is "<keyword> <reply...>"; for "remove" it is the keyword' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (!sub || sub === 'list') {
      const all = ctx.rules.list();
      if (!all.length) return 'No auto-replies here.';
      return [b('Auto-replies'), bullet(all.map((r) => `${code(r.keyword)} -> ${esc(r.reply)}`))].join('\n');
    }

    if (sub === 'add') {
      const keyword = (ctx.args[1] ?? '').toLowerCase();
      const reply = ctx.args.slice(2).join(' ').trim();
      if (!keyword || !reply) return `Usage: ${code('jarvis rule add <keyword> <reply...>')}`;
      if (ctx.commands.some((c) => c.name === keyword)) return `${code(esc(keyword))} is a built-in command - pick another keyword.`;
      const r = ctx.rules.add(keyword, reply);
      if (r.ok) return `Auto-reply for ${code(r.keyword)} saved.`;
      return r.reason === 'bad-keyword'
        ? 'A keyword must be a single word (letters, digits, - or _).'
        : r.reason === 'empty-reply'
          ? 'Give the reply text.'
          : r.reason === 'too-long'
            ? `That reply is too long (max ${r.max} characters).`
            : `Too many auto-replies here (max ${r.max}); remove some first.`;
    }

    if (sub === 'remove') {
      const keyword = (ctx.args[1] ?? '').toLowerCase();
      if (!keyword) return `Usage: ${code('jarvis rule remove <keyword>')}`;
      return ctx.rules.remove(keyword) ? `Removed auto-reply ${code(keyword)}.` : `No auto-reply "${esc(keyword)}".`;
    }

    return `Usage: ${code('jarvis rule add <keyword> <reply...> | list | remove <keyword>')}`;
  },
};
