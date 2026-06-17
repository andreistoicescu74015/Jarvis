import { areJidsSameUser } from 'baileys';

/**
 * The addressing rule for WhatsApp (per the behavior decision): a message is for
 * the bot iff its text starts with the prefix OR the bot's own JID is @mentioned.
 * Nothing else is read - there is no ambient processing. Pure, fixture-testable.
 */

/**
 * True if the bot is among the mentioned JIDs (LID-aware match). The bot is
 * addressable by more than one id - its phone-number JID and its LID - and in v7
 * groups a mention usually arrives as the LID, so `selfId` may be either form (or
 * an array of forms) and a match against any one counts.
 *
 * @param {string[] | undefined} mentionedJid
 * @param {string | string[]} selfId  The bot's own JID(s) - phone-number and/or LID.
 * @returns {boolean}
 */
export function mentionsBot(mentionedJid, selfId) {
  const selves = (Array.isArray(selfId) ? selfId : [selfId]).filter(Boolean);
  if (!selves.length || !Array.isArray(mentionedJid)) return false;
  return mentionedJid.some((jid) => selves.some((self) => areJidsSameUser(jid, self)));
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
 * The mention may use either of the bot's id forms (phone-number or LID), so we
 * strip the user part of each `selfId`.
 *
 * @param {string} text
 * @param {string | string[]} selfId  The bot's own JID(s) (e.g. `1234@s.whatsapp.net`, `5678@lid`).
 * @returns {string} text with the bot mention removed and whitespace collapsed.
 */
export function stripBotMention(text, selfId) {
  const selves = (Array.isArray(selfId) ? selfId : [selfId]).filter(Boolean);
  let out = String(text ?? '');
  for (const self of selves) {
    const user = String(self).split('@')[0].split(':')[0];
    if (user) out = out.replace(new RegExp(`@${user}\\b`, 'g'), '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve addressing for an inbound message. `handle` says whether the adapter
 * should process it at all; `bare` marks the mention path, where the text carries
 * no prefix and the core must parse it as a bare command; `text` is what the core
 * should parse (mention stripped when `bare`).
 *
 * @param {{ text: string, mentionedJid?: string[] }} msg
 * @param {{ selfId: string | string[], prefix: string }} opts
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
