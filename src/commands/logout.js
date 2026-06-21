/** @type {import('../core/registry.js').Command} */
export default {
  name: 'logout',
  summary: 'Owner: disconnect and forget this WhatsApp session.',
  usage: 'jarvis logout',
  scope: { owner: true },
  confirm: true, // destructive - never auto-run from an AI translation; the user must type it
  run: (ctx) => {
    if (typeof ctx.lifecycle?.logout !== 'function') return 'Not supported here.';
    ctx.lifecycle.logout();
    return 'Logging out - you will need to scan a new QR to reconnect.';
  },
};
