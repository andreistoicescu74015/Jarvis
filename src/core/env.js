/**
 * Read a numeric environment variable, falling back to `fallback` for an unset, empty,
 * or non-finite value - but honoring an explicit `0` (which the common `Number(x) || d`
 * idiom would wrongly clobber). Shared by the composition roots and the health check so
 * every numeric knob is parsed the same way.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
export function num(value, fallback) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value);
}
