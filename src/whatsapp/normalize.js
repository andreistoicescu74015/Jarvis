import { normalizeMessageContent } from 'baileys';
import { levelOf, isAdminInGroup, normalizeUser } from './identity.js';

/**
 * Turn a raw Baileys message into the core's inbound shape (plus `mentionedJid`,
 * which the trigger needs). Pure - no socket. The caller passes optional
 * `groupMetadata` (from the socket in production; a fixture in tests) to resolve
 * the community level and the sender's admin status. `normalizeMessageContent`
 * unwraps ephemeral / viewOnce / edited wrappers first. Returns null when there
 * is no usable text content (media without a caption, reactions, etc.).
 *
 * @param {{ key?: object, message?: object }} wa  A WAMessage (proto.IWebMessageInfo).
 * @param {{ groupMetadata?: any }} [opts]
 * @returns {(import('../core/app.js').InboundMessage & { mentionedJid: string[] }) | null}
 */
export function toInbound(wa, { groupMetadata } = {}) {
  const key = wa?.key ?? {};
  const remoteJid = key.remoteJid ?? '';
  if (!remoteJid) return null;

  const content = normalizeMessageContent(wa?.message);
  if (!content) return null;

  const text = extractText(content);
  if (text == null) return null; // nothing addressable (no text / caption)

  const sender = normalizeUser(key.participant || remoteJid);
  const level = levelOf(remoteJid, groupMetadata);
  const ctxInfo = contextInfoOf(content);

  return {
    kind: 'message',
    text,
    chatId: remoteJid,
    sender,
    level,
    fromMe: !!key.fromMe,
    isAdmin: level === 'private' ? false : isAdminInGroup(sender, groupMetadata),
    mentionedJid: ctxInfo?.mentionedJid ?? [],
    raw: wa,
  };
}

/** Text from a normalized content node: plain conversation, extended text, or a media caption. */
function extractText(content) {
  if (typeof content.conversation === 'string') return content.conversation;
  if (content.extendedTextMessage?.text != null) return content.extendedTextMessage.text;
  const caption =
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption;
  return caption != null ? caption : null;
}

/** The contextInfo carried by whichever content node has it (extended text or media). */
function contextInfoOf(content) {
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    null
  );
}
