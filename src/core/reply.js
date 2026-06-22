/**
 * A "mis-usage" reply: a command saying it could not interpret the given arguments - distinct from a
 * normal string reply, so the dispatcher can offer an AI suggestion of what the user likely meant
 * (instead of just a terse usage line). Use it for the "I don't understand this" returns where the
 * intent is unclear (an unrecognized subcommand, a non-command target, missing required args) - NOT
 * for a clear, deliberate refusal (e.g. "owner-only").
 *
 * `.text` is the usage/error to show; the brand lets `isMisuse` detect it without affecting rendering
 * (the dispatcher unwraps it). Kept tiny and dependency-free, like the rest of the core.
 */
const MISUSE = Symbol('misuse');

/** Wrap a usage/error string as a mis-usage reply (the dispatcher may add an AI "did you mean" hint). */
export const misuse = (text) => ({ [MISUSE]: true, text: String(text) });

/** Whether a command's return value is a mis-usage reply. */
export const isMisuse = (v) => !!(v && typeof v === 'object' && v[MISUSE] === true);
