import { b, code, number, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

// Bounds so a conversation cannot grow the store without limit (the note list is one KV
// value, rewritten whole on each add): a per-note length cap and a per-conversation count.
const MAX_NOTE_LEN = 1000; // characters in a single note
const MAX_NOTES = 500; // notes kept per conversation

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'note',
  summary: 'Keep simple notes, scoped to this conversation.',
  usage: 'jarvis note add <text> | list | get <n> | del <n> | clear',
  man:
    'Notes are scoped to this conversation. Subcommands: add <text> (append a note), ' +
    'list (show all), get <n> (show one), del <n> (remove one), clear (remove all at once).',
  requires: ['store'],
  // `clear` wipes every note here at once - destructive, so the AI translator never auto-runs it
  // from a guess (the user must type it); `add`/`get`/`del`/`list` stay auto-runnable.
  confirm: (args) => (args[0] ?? '').toLowerCase() === 'clear',
  params: [
    { name: 'action', enum: ['add', 'list', 'get', 'del', 'clear'], required: true, desc: 'what to do' },
    { name: 'text', variadic: true, desc: 'the note text (for add), or the note number (for get/del)' },
  ],
  run: (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    const rest = ctx.args.slice(1);
    const notes = /** @type {string[]} */ (ctx.store.get('notes') ?? []);

    switch (sub) {
      case 'add': {
        const text = rest.join(' ').trim();
        if (!text) return misuse(`Usage: ${code('jarvis note add <text>')}`);
        if (text.length > MAX_NOTE_LEN) return `Note too long (max ${MAX_NOTE_LEN} characters).`;
        if (notes.length >= MAX_NOTES) return `Too many notes here (max ${MAX_NOTES}); delete some first.`;
        notes.push(text);
        ctx.store.set('notes', notes);
        return `Added note #${notes.length}.`;
      }
      case 'list':
        return notes.length ? [b('Notes'), number(notes.map((n) => esc(n)))].join('\n') : 'No notes yet.';
      case 'get': {
        const note = notes[Number(rest[0]) - 1];
        return note != null ? esc(note) : `No note #${esc(rest[0] ?? '?')}.`;
      }
      case 'del': {
        const i = Number(rest[0]) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= notes.length) {
          return `No note #${esc(rest[0] ?? '?')}.`;
        }
        const [removed] = notes.splice(i, 1);
        ctx.store.set('notes', notes);
        return `Deleted note: ${esc(removed)}`;
      }
      case 'clear': {
        if (!notes.length) return 'No notes to clear.';
        ctx.store.delete('notes');
        return `Cleared all ${notes.length} notes here.`;
      }
      default:
        return misuse(`Usage: ${code('jarvis note add <text> | list | get <n> | del <n> | clear')}`);
    }
  },
};
