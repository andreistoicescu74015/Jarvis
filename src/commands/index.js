import ping from './ping.js';
import help from './help.js';
import man from './man.js';
import whoami from './whoami.js';
import note from './note.js';
import owner from './owner.js';
import whitelist from './whitelist.js';
import blacklist from './blacklist.js';
import groups from './groups.js';
import community from './community.js';
import ai from './ai.js';
import alias from './alias.js';
import link from './link.js';
import schedule from './schedule.js';
import feed from './feed.js';
import rule from './rule.js';
import reset from './reset.js';
import shutdown from './shutdown.js';
import restart from './restart.js';
import logout from './logout.js';

/**
 * The full command set, in one place. Both composition roots (`cli.js`,
 * `whatsapp-main.js`) build their registry from this list, so adding a command is a
 * single edit here instead of two parallel import blocks that can drift.
 */
export const commands = [
  ping,
  help,
  man,
  whoami,
  note,
  owner,
  whitelist,
  blacklist,
  groups,
  community,
  ai,
  alias,
  link,
  schedule,
  feed,
  rule,
  reset,
  shutdown,
  restart,
  logout,
];
