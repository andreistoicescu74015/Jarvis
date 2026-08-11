import { code } from '../core/format.js';

/** @type {import('../core/registry.js').Command} */
export default {
  name: 'logout',
  summary: 'Owner: disconnect and forget this WhatsApp session.',
  usage: 'jarvis logout',
  man:
    'Unlinks this WhatsApp device and forgets the login, then restarts and prints a fresh QR code.\n' +
    'You pair again by scanning it, the way you did the first time.\n' +
    'Your data stays: notes, schedules, access lists and the ownership are all still there afterwards.\n' +
    `${code('jarvis reset all')} is the opposite - it wipes the data and keeps the login.`,
  scope: { owner: true },
  confirm: true, // destructive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.logout !== 'function') return 'Not supported here.';
    ctx.lifecycle.logout();
    return 'Logging out - you will need to scan a new QR to reconnect.';
  },
};
