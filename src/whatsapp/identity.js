import { jidNormalizedUser, isJidGroup, areJidsSameUser } from 'baileys';

/**
 * Identity / JID helpers for the WhatsApp adapter. WhatsApp v7 is LID-primary, so
 * we normalize defensively and never infer trust from identity (crossover stays
 * code-based). Pure functions - no socket, unit-testable with fixtures.
 */

/**
 * Normalize a JID to its bare user form (drops device/agent suffix), tolerating null.
 *
 * @param {string | null | undefined} jid
 * @returns {string} the normalized jid, or '' if absent/invalid.
 */
export function normalizeUser(jid) {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid) || '';
  } catch {
    return '';
  }
}

/**
 * The conversation level of a chat. Group vs private comes from the JID; a group
 * counts as a *community* only when its metadata says so. We read the truthy flags
 * Baileys already surfaces (`isCommunity` / `linkedParent`) rather than calling the
 * community API (which v7 does expose) - classifying runs per message, and the flags
 * are enough to tell a community apart. Without metadata a group stays 'group'.
 *
 * @param {string} remoteJid
 * @param {{ isCommunity?: boolean, linkedParent?: unknown } | undefined} [groupMetadata]
 * @returns {'private'|'group'|'community'}
 */
export function levelOf(remoteJid, groupMetadata) {
  if (!isJidGroup(remoteJid)) return 'private';
  // The same two flags `communityIdOf` reads, so the level and the resolved community jid never diverge.
  if (groupMetadata && (groupMetadata.isCommunity || groupMetadata.linkedParent)) {
    return 'community';
  }
  return 'group';
}

/**
 * The community (announcement-group) jid a chat belongs to, or undefined when the
 * chat is not part of one. The announcement group is its own community id
 * (`isCommunity`); a sub-group points at its parent (`linkedParent`). This is what
 * a community read should target - calling the community API with a sub-group's own
 * jid would not resolve the community. Pure.
 *
 * @param {string} remoteJid
 * @param {{ isCommunity?: boolean, linkedParent?: unknown } | undefined} [groupMetadata]
 * @returns {string | undefined}
 */
export function communityIdOf(remoteJid, groupMetadata) {
  if (!groupMetadata) return undefined;
  if (groupMetadata.linkedParent) return String(groupMetadata.linkedParent);
  if (groupMetadata.isCommunity) return remoteJid;
  return undefined;
}

/**
 * Whether a participant is a group admin. Baileys marks admins as the string
 * 'admin' or 'superadmin' on `participant.admin` (NOT booleans).
 *
 * @param {{ admin?: string | null } | undefined} participant
 * @returns {boolean}
 */
export function isAdminParticipant(participant) {
  const a = participant?.admin;
  return a === 'admin' || a === 'superadmin';
}

/**
 * Resolve a sender's admin status from group metadata participants (LID-aware match).
 *
 * @param {string} senderJid
 * @param {{ participants?: Array<{ id?: string, admin?: string | null }> } | undefined} groupMetadata
 * @returns {boolean}
 */
export function isAdminInGroup(senderJid, groupMetadata) {
  const parts = groupMetadata?.participants;
  if (!parts || !senderJid) return false;
  const p = parts.find((x) => areJidsSameUser(x.id, senderJid));
  return isAdminParticipant(p);
}
