/** @type {import('../core/registry.js').Command} */
export default {
  name: 'logout',
  summary: 'Owner: disconnect and forget this WhatsApp session.',
  usage: 'jarvis logout',
  scope: { owner: true },
  run: (ctx) => {
    if (typeof ctx.lifecycle?.logout !== 'function') return 'Not supported here.';
    ctx.lifecycle.logout();
    return 'Logging out - you will need to scan a new QR to reconnect.';
  },
};
