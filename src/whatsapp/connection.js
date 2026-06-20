import { DisconnectReason } from 'baileys';

/**
 * Map a connection-close status code to a lifecycle action. The socket is dead after any
 * close; the action says what to do next. Pure - unit-testable.
 *
 * - 401 loggedOut          -> 'logout'    (wipe creds; do not reconnect; re-pair).
 * - 515 restartRequired    -> 'restart'   (recreate the socket; the post-pairing handshake).
 * - 440 connectionReplaced -> 'stop'      (another session took over; reconnecting would fight it).
 * - 403 forbidden          -> 'stop'      (the account is blocked/banned; do not hammer it).
 * - 500 badSession         -> 'stop'      (unrecoverable session; reconnecting will not fix it).
 * - anything else          -> 'reconnect' (after a backoff delay).
 *
 * 'restart' and 'reconnect' both recreate the socket and differ only in intent; the adapter
 * paces and caps them. 'stop' is terminal: keep the process down rather than auto-fight a
 * takeover or hammer a banned account (the unattended ban-safety call).
 *
 * @param {number | undefined} statusCode
 * @returns {'logout'|'restart'|'reconnect'|'stop'}
 */
export function disconnectAction(statusCode) {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return 'logout';
    case DisconnectReason.restartRequired:
      return 'restart';
    case DisconnectReason.connectionReplaced:
    case DisconnectReason.forbidden:
    case DisconnectReason.badSession:
      return 'stop';
    default:
      return 'reconnect';
  }
}

/**
 * A short, stable label for why a close is terminal ('stop') - for the operator log and the
 * exit-code decision at the composition root.
 *
 * @param {number | undefined} statusCode
 * @returns {'replaced'|'forbidden'|'badSession'|'stopped'}
 */
export function stopReason(statusCode) {
  switch (statusCode) {
    case DisconnectReason.connectionReplaced:
      return 'replaced';
    case DisconnectReason.forbidden:
      return 'forbidden';
    case DisconnectReason.badSession:
      return 'badSession';
    default:
      return 'stopped';
  }
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
