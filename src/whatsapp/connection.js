import { DisconnectReason } from 'baileys';

/**
 * Map a connection-close status code to the lifecycle action. The socket is dead
 * after any close, so 'restart' and 'reconnect' both mean "create a NEW socket";
 * they differ only in timing. Pure - unit-testable.
 *
 * - 515 restartRequired -> 'restart' (immediately, post-pairing handshake).
 * - 401 loggedOut       -> 'logout'  (stop and wipe creds; do not reconnect).
 * - anything else        -> 'reconnect' (after a backoff delay).
 *
 * @param {number | undefined} statusCode
 * @returns {'restart'|'logout'|'reconnect'}
 */
export function disconnectAction(statusCode) {
  if (statusCode === DisconnectReason.loggedOut) return 'logout';
  if (statusCode === DisconnectReason.restartRequired) return 'restart';
  return 'reconnect';
}

/**
 * Exponential backoff with a cap and full jitter, for reconnect attempts.
 *
 * @param {number} attempt  0-based attempt counter.
 * @param {{ baseMs?: number, capMs?: number, rand?: () => number }} [opts]
 * @returns {number} milliseconds to wait (0 .. min(cap, base*2^attempt)).
 */
export function backoffMs(attempt, { baseMs = 1000, capMs = 30000, rand = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * ceiling);
}
