/**
 * Declarative permission requirements a command can opt into.
 *
 * @typedef {Object} Scope
 * @property {'private'|'group'|'community'} [level]  Restrict to a conversation level.
 * @property {boolean} [admin]                        Require a group admin (ignored in private).
 * @property {boolean} [owner]                        Require the bot owner.
 *
 * @typedef {Object} ScopeResult
 * @property {boolean} ok
 * @property {string} [reason]
 */

/**
 * Compare two ids as the same user. Drops a `:device` suffix (`user:3@domain` ->
 * `user@domain`) but keeps the domain, so different id spaces never collide
 * (`x@lid` is NOT `x@s.whatsapp.net`). Bridging those two spaces for one person is
 * the identity store's job (it maps LID <-> phone), not this comparison.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameUser(a, b) {
  if (!a || !b) return false;
  const bare = (s) => String(s).trim().toLowerCase().replace(/:\d+(?=@|$)/, '');
  return bare(a) === bare(b);
}

/**
 * Check whether an invocation satisfies a command's scope.
 *
 * @param {Scope} [scope]
 * @param {{ level: string, isAdmin: boolean, isOwner: boolean }} ctx
 * @returns {ScopeResult}
 */
export function checkScope(scope, ctx) {
  if (!scope) return { ok: true };
  if (scope.level && scope.level !== ctx.level) {
    return { ok: false, reason: `only in ${scope.level} chats` };
  }
  if (scope.owner && !ctx.isOwner) {
    return { ok: false, reason: 'owner only' };
  }
  // admin is meaningful only in groups; in private the user is the authority.
  if (scope.admin && ctx.level === 'group' && !ctx.isAdmin) {
    return { ok: false, reason: 'admins only' };
  }
  return { ok: true };
}
