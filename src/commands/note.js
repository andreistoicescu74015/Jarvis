import { b, i, code, page, esc } from '../core/format.js';
import { misuse } from '../core/reply.js';

// Bounds so a conversation cannot grow the store without limit (the note list is one KV
// value, rewritten whole on each add): a per-note length cap and a per-conversation count.
const MAX_NOTE_LEN = 1000; // characters in a single note
const MAX_NOTES = 500; // notes kept per conversation
const PAGE = 20; // notes shown by one `note list` (the newest); the rest are reachable by number

/**
 * The chat's notes as `{ seq, items }`, where each item carries a STABLE id. Notes used to be a bare
 * array of strings numbered by position, so deleting one renumbered every note after it and a number
 * copied from an earlier listing pointed at a different note - the classic way to delete the wrong
 * thing. A legacy array is migrated on read (positions become the initial ids), so existing notes
 * keep the numbers their chat already knows.
 */
function readNotes(store) {
  const raw = store.get('notes');
  if (Array.isArray(raw)) return { seq: raw.length, items: raw.map((text, n) => ({ id: n + 1, text: String(text) })) };
  if (raw && Array.isArray(raw.items)) return { seq: Number(raw.seq) || raw.items.length, items: raw.items };
  return { seq: 0, items: [] };
}

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'note',
  summary: 'Keep simple notes, scoped to this conversation.',
  usage: 'jarvis note add <text> | list | get <n> | del <n> | clear',
  man:
    "Notes belong to this chat: a group keeps the group's, a private chat keeps yours.\n" +
    `${code('jarvis note add <text>')} saves one and tells you its number.\n` +
    `${code('jarvis note list')} shows the newest ones, ${code('jarvis note get <n>')} shows one in full.\n` +
    `${code('jarvis note del <n>')} removes one - the others keep their numbers, so a number stays valid.\n` +
    `${code('jarvis note clear')} removes them all at once.`,
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
    const notes = readNotes(ctx.store);
    const find = (token) => {
      const id = Number(token);
      return Number.isInteger(id) ? notes.items.findIndex((n) => n.id === id) : -1;
    };

    switch (sub) {
      case 'add': {
        const text = rest.join(' ').trim();
        if (!text) return misuse(`Usage: ${code('jarvis note add <text>')}`);
        if (text.length > MAX_NOTE_LEN) return `Note too long (max ${MAX_NOTE_LEN} characters).`;
        if (notes.items.length >= MAX_NOTES) return `Too many notes here (max ${MAX_NOTES}); delete some first.`;
        notes.seq += 1;
        notes.items.push({ id: notes.seq, text });
        ctx.store.set('notes', notes);
        return `Added note #${notes.seq}.`;
      }
      case 'list': {
        if (!notes.items.length) return 'No notes yet.';
        // The newest are what a chat comes back for, and the whole list would not fit one message.
        const { shown, hidden, total } = page(notes.items, { limit: PAGE, tail: true });
        const lines = shown.map((n) => `${n.id}. ${esc(n.text)}`);
        const out = [b('Notes'), ...lines];
        if (hidden) out.push(i(`Showing the newest ${shown.length} of ${total}. ${code('jarvis note get <n>')} shows any one.`));
        return out.join('\n');
      }
      case 'get': {
        const at = find(rest[0]);
        return at >= 0 ? esc(notes.items[at].text) : `No note #${esc(rest[0] ?? '?')}.`;
      }
      case 'del': {
        const at = find(rest[0]);
        if (at < 0) return `No note #${esc(rest[0] ?? '?')}.`;
        const [removed] = notes.items.splice(at, 1);
        ctx.store.set('notes', notes);
        // The other notes keep their numbers, so a number read a minute ago still means this note.
        return `Deleted note #${removed.id}: ${esc(removed.text)}`;
      }
      case 'clear': {
        if (!notes.items.length) return 'No notes to clear.';
        ctx.store.delete('notes');
        return `Cleared all ${notes.items.length} notes here.`;
      }
      default:
        return misuse(`Usage: ${code('jarvis note add <text> | list | get <n> | del <n> | clear')}`);
    }
  },
};
