/**
 * Deterministic, dependency-free "did you mean?" for command tokens. Given a typed word and the known
 * command names, return the single closest name within a small edit-distance budget, or null. Used by
 * the dispatcher to turn a typo ("scedule") into a suggestion BEFORE the AI translation branch - no LLM,
 * and a token-cost saver. It only ever suggests; the dispatcher never auto-runs the guess.
 *
 * The budget scales with length so short tokens don't over-match (a 2-char word is 1 edit from many
 * things): tokens under 3 chars are not matched at all, 3-4 chars allow 1 edit, longer allow 2. A tie
 * for the best distance returns null - better to say nothing than guess between equally-close names.
 *
 * @param {string} input    The typed (unknown) command token.
 * @param {string[]} names  The known command names.
 * @returns {string | null}
 */
export function closest(input, names) {
  const a = String(input ?? '').toLowerCase();
  if (a.length < 3) return null; // too short to fuzzy-match without false positives
  const max = a.length <= 4 ? 1 : 2;
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const name of names ?? []) {
    const d = distance(a, String(name).toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = name;
      tie = false;
    } else if (d === bestD) {
      tie = true;
    }
  }
  return best !== null && bestD <= max && !tie ? best : null;
}

/**
 * Levenshtein edit distance (insert/delete/substitute), iterative two-row. Inputs are command-name
 * sized, so the O(n*m) cost is trivial.
 */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
