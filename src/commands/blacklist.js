import { makeAccessCommand } from '../core/access-command.js';

/**
 * Owner-only: block specific people from a command (or the whole bot). The shared
 * implementation lives in the core so this stays a leaf.
 *
 * @type {import('../core/registry.js').Command}
 */
export default makeAccessCommand('blacklist');
