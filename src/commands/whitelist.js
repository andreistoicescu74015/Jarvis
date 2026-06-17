import { makeAccessCommand } from '../core/access-command.js';

/**
 * Owner-only: limit a command (or the whole bot) to specific people. The shared
 * implementation lives in the core so this stays a leaf.
 *
 * @type {import('../core/registry.js').Command}
 */
export default makeAccessCommand('whitelist');
