/**
 * Reply formatting via a small NEUTRAL markup, so commands can style their output without
 * knowing the platform. Builders wrap text in private sentinel control characters; each
 * adapter then renders the markup its own way - `toWhatsApp` to WhatsApp's syntax, `toPlain`
 * to clean text for the dev CLI. The sentinels never reach the user.
 *
 * Why neutral markup instead of raw `*bold*` in commands: the same reply string is printed
 * by the CLI and carries user content, so hardcoding WhatsApp syntax would show raw markers
 * on the CLI and let user text break the formatting. Keeping the syntax out of commands also
 * respects the adapter being the only platform boundary - commands stay platform-agnostic.
 *
 * `esc()` neutralizes interpolated user content so a stray `*` / `_` / `~` / `` ` `` in a
 * note, a group name, or a scheduled message can neither inject our markup nor hijack the
 * surrounding WhatsApp formatting.
 *
 * The control characters are built with `String.fromCharCode` so the source stays plain ASCII.
 */

// Private sentinels (control chars) marking a styled span; each is paired (open == close).
const BOLD = String.fromCharCode(1);
const ITALIC = String.fromCharCode(2);
const STRIKE = String.fromCharCode(3);
const MONO = String.fromCharCode(4);
const CODE = String.fromCharCode(5);
const ZWSP = String.fromCharCode(0x200b); // zero-width space, used to defang user markers
const SENTINELS = new RegExp(`[${BOLD}${ITALIC}${STRIKE}${MONO}${CODE}]`, 'g');

export const b = (t) => `${BOLD}${t}${BOLD}`;
export const i = (t) => `${ITALIC}${t}${ITALIC}`;
export const strike = (t) => `${STRIKE}${t}${STRIKE}`;
export const mono = (t) => `${MONO}${t}${MONO}`; // monospace block: triple-backtick (for code that stands out)
export const code = (t) => `${CODE}${t}${CODE}`; // inline code: single-backtick (commands, ids, short references)

/** A bulleted list from an array of (already-built) lines (`- ` renders as a bullet on WhatsApp too). */
export const bullet = (items) => items.map((x) => `- ${x}`).join('\n');
/** A numbered list from an array of (already-built) lines. */
export const number = (items) => items.map((x, n) => `${n + 1}. ${x}`).join('\n');
/** A block quote; WhatsApp and the CLI both show a leading `> ` per line. */
export const quote = (t) => String(t).split('\n').map((l) => `> ${l}`).join('\n');

/**
 * Cap a listing to what one chat message can usefully carry. A reply is read on a phone, and the
 * stores behind these listings hold hundreds of entries - at their caps a full listing runs past
 * WhatsApp's per-message limit, the send fails, and the reader gets nothing at all. So every listing
 * shows a slice and says what it left out.
 *
 * `tail` takes the LAST items instead of the first, for append-only lists (notes) where the newest
 * matter most; a list already sorted by relevance (soonest schedule, alphabetical rules) keeps the head.
 *
 * @param {T[]} items
 * @param {{ limit?: number, tail?: boolean }} [opts]
 * @returns {{ shown: T[], hidden: number, total: number }}
 * @template T
 */
export function page(items, { limit = 20, tail = false } = {}) {
  const all = Array.isArray(items) ? items : [];
  if (all.length <= limit) return { shown: all, hidden: 0, total: all.length };
  return { shown: tail ? all.slice(-limit) : all.slice(0, limit), hidden: all.length - limit, total: all.length };
}

/**
 * Neutralize interpolated user content: strip our sentinels (so it cannot inject styling)
 * and break WhatsApp marker pairing with a zero-width space (best-effort, so a `*`/`_`/`~`/
 * `` ` `` typed by a user cannot bold/italicize or hijack the rest of the reply).
 */
export const esc = (text) => String(text ?? '').replace(SENTINELS, '').replace(/[*_~`]/g, `$&${ZWSP}`);

/** Render neutral markup to WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```, `code`. */
export const toWhatsApp = (text) =>
  String(text ?? '')
    .replaceAll(BOLD, '*')
    .replaceAll(ITALIC, '_')
    .replaceAll(STRIKE, '~')
    .replaceAll(MONO, '```')
    .replaceAll(CODE, '`');

/** Render neutral markup to clean plain text (all markup removed) for the CLI and tests. */
export const toPlain = (text) => String(text ?? '').replace(SENTINELS, '').replaceAll(ZWSP, '');
