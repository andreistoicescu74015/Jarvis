/** @type {import('../core/registry.js').Command} */
export default {
  name: 'note',
  summary: 'Keep simple notes, scoped to this conversation.',
  usage: 'jarvis note add <text> | list | get <n> | del <n>',
  run: (ctx) => {
    if (!ctx.store) return 'Notes are unavailable here.';
    const [sub, ...rest] = ctx.args;
    const notes = /** @type {string[]} */ (ctx.store.get('notes') ?? []);

    switch (sub) {
      case 'add': {
        const text = rest.join(' ').trim();
        if (!text) return 'Usage: jarvis note add <text>';
        notes.push(text);
        ctx.store.set('notes', notes);
        return `Added note #${notes.length}.`;
      }
      case 'list':
        return notes.length
          ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n')
          : 'No notes yet.';
      case 'get': {
        const note = notes[Number(rest[0]) - 1];
        return note ?? `No note #${rest[0] ?? '?'}.`;
      }
      case 'del': {
        const i = Number(rest[0]) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= notes.length) {
          return `No note #${rest[0] ?? '?'}.`;
        }
        const [removed] = notes.splice(i, 1);
        ctx.store.set('notes', notes);
        return `Deleted note: ${removed}`;
      }
      default:
        return 'Usage: jarvis note add <text> | list | get <n> | del <n>';
    }
  },
};
