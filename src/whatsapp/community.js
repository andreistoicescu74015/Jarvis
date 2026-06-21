/**
 * Community shaping for the WhatsApp adapter. Turns the raw Baileys community
 * payloads (a GroupMetadata for the announcement group + the result of
 * `communityFetchLinkedGroups`) into clean, platform-neutral value objects, so
 * commands never see raw Baileys shapes. Pure - no socket, unit-testable with
 * fixtures. The read side only; community management lives elsewhere.
 *
 * @typedef {Object} SubGroup
 * @property {string} id
 * @property {string} name
 * @property {number} [size]   Member count, when WhatsApp reports it.
 *
 * @typedef {Object} Community
 * @property {string} id              The community (announcement-group) jid.
 * @property {string} name
 * @property {string} [description]
 * @property {SubGroup[]} subGroups   The linked groups.
 * @property {number} reach           Total community members (the announcement audience), 0 if unknown.
 */

/**
 * Shape the `communityFetchLinkedGroups` result into SubGroup[]. Tolerates a
 * missing or partial payload (returns []), and drops entries without an id.
 *
 * @param {{ linkedGroups?: Array<{ id?: string, subject?: string, size?: number }> } | undefined} linked
 * @returns {SubGroup[]}
 */
export function toSubGroups(linked) {
  return (linked?.linkedGroups ?? [])
    .filter((g) => g?.id)
    .map((g) => ({
      id: String(g.id),
      name: g.subject || String(g.id),
      ...(Number.isFinite(g.size) ? { size: g.size } : {}),
    }));
}

/**
 * Combine a community's metadata (name / description / member count) with its
 * linked groups into a Community. `meta` is the announcement group's
 * GroupMetadata. Returns undefined when the metadata has no id (nothing usable).
 *
 * @param {{ id?: string, subject?: string, desc?: string, size?: number, participants?: unknown[] } | undefined} meta
 * @param {Parameters<typeof toSubGroups>[0]} [linked]
 * @returns {Community | undefined}
 */
export function toCommunity(meta, linked) {
  if (!meta?.id) return undefined;
  const reach = Number.isFinite(meta.size)
    ? meta.size
    : Array.isArray(meta.participants)
      ? meta.participants.length
      : 0;
  return {
    id: String(meta.id),
    name: meta.subject || String(meta.id),
    ...(meta.desc ? { description: String(meta.desc) } : {}),
    subGroups: toSubGroups(linked),
    reach,
  };
}
