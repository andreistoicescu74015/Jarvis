import { areJidsSameUser } from 'baileys';

/**
 * The addressing rule for WhatsApp (per the behavior decision): a message is for
 * the bot iff its text starts with the prefix OR the bot's own JID is @mentioned.
 * Nothing else is read - there is no ambient processing. Pure, fixture-testable.
 */

/**
 * True if the bot (`selfId`) is among the mentioned JIDs (LID-aware match).
 *
 * @param {string[] | undefined} mentionedJid
 * @param {string} selfId  The bot's own JID.
 * @returns {boolean}
 */
export function mentionsBot(mentionedJid, selfId) {
  if (!selfId || !Array.isArray(mentionedJid)) return false;
  return mentionedJid.some((jid) => areJidsSameUser(jid, selfId));
}

/**
 * Whether text begins with the addressing prefix (case-insensitive): exactly the
 * prefix, or the prefix followed by a space.
 *
 * @param {string} text
 * @param {string} prefix
 * @returns {boolean}
 */
export function startsWithPrefix(text, prefix) {
  const t = (text ?? '').trim().toLowerCase();
  const p = prefix.toLowerCase();
  return t === p || t.startsWith(`${p} `);
}

/**
 * Remove the bot's `@mention` token(s) from text so the command parses cleanly.
 * WhatsApp renders a mention as `@<user>`, where `<user>` is the JID's user part.
 *
 * @param {string} text
 * @param {string} selfId  The bot's own JID (e.g. `1234@s.whatsapp.net`).
 * @returns {string} text with the bot mention removed and whitespace collapsed.
 */
export function stripBotMention(text, selfId) {
  const raw = String(text ?? '');
  const user = String(selfId ?? '').split('@')[0].split(':')[0];
  if (!user) return raw.trim();
  return raw.replace(new RegExp(`@${user}\\b`, 'g'), '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve addressing for an inbound message. `handle` says whether the adapter
 * should process it at all; `bare` marks the mention path, where the text carries
 * no prefix and the core must parse it as a bare command; `text` is what the core
 * should parse (mention stripped when `bare`).
 *
 * @param {{ text: string, mentionedJid?: string[] }} msg
 * @param {{ selfId: string, prefix: string }} opts
 * @returns {{ handle: boolean, bare: boolean, text: string }}
 */
export function resolveAddressing(msg, { selfId, prefix }) {
  const hasPrefix = startsWithPrefix(msg.text, prefix);
  const bare = !hasPrefix && mentionsBot(msg.mentionedJid, selfId);
  return {
    handle: hasPrefix || bare,
    bare,
    text: bare ? stripBotMention(msg.text, selfId) : (msg.text ?? ''),
  };
}
