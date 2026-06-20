/**
 * Liveness heartbeat shared by the running bot (which writes it) and the container HEALTHCHECK
 * (which reads it). While connected to WhatsApp, the composition root writes the current epoch ms
 * to a file on a short interval; this decides whether that heartbeat is recent enough to call the
 * process healthy. A stale or missing heartbeat means the bot is wedged or has been disconnected
 * too long. Pure - unit-testable, no I/O.
 *
 * @param {string} content   The heartbeat file's contents (an epoch-ms timestamp as text).
 * @param {number} now       Current time in ms.
 * @param {number} maxAgeMs  How old the heartbeat may be and still count as healthy.
 * @returns {boolean}
 */
export function isFresh(content, now, maxAgeMs) {
  const t = Number(String(content).trim());
  return Number.isFinite(t) && t > 0 && now - t < maxAgeMs;
}
