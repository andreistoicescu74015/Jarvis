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
 * counts as a *community* only when its metadata says so - v7 has no dedicated
 * community API, so we test truthy flags. Without metadata a group stays 'group'.
 *
 * @param {string} remoteJid
 * @param {{ isCommunity?: boolean, linkedParent?: unknown, communityId?: unknown } | undefined} [groupMetadata]
 * @returns {'private'|'group'|'community'}
 */
export function levelOf(remoteJid, groupMetadata) {
  if (!isJidGroup(remoteJid)) return 'private';
  if (groupMetadata && (groupMetadata.isCommunity || groupMetadata.linkedParent || groupMetadata.communityId)) {
    return 'community';
  }
  return 'group';
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
