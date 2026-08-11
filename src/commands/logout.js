/** @type {import('../core/registry.js').Command} */
export default {
  name: 'logout',
  summary: 'Owner: disconnect and forget this WhatsApp session.',
  usage: 'jarvis logout',
  man:
    'Unlink this WhatsApp device and wipe the stored credentials, then restart so a fresh QR is ' +
    'printed - you pair again by scanning it from the phone. Your DATA is kept (notes, schedules, ' +
    'access lists, ownership); only the login goes. Use "reset all" to wipe data and keep the login.',
  scope: { owner: true },
  confirm: true, // destructive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.logout !== 'function') return 'Not supported here.';
    ctx.lifecycle.logout();
    return 'Logging out - you will need to scan a new QR to reconnect.';
  },
};
