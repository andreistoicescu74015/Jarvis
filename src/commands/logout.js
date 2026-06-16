/** @type {import('../core/registry.js').Command} */
export default {
  name: 'logout',
  summary: 'Disconnect and forget this WhatsApp session (owner only).',
  usage: 'jarvis logout',
  scope: { owner: true },
  run: (ctx) => {
    if (typeof ctx.lifecycle?.logout !== 'function') return 'Not supported here.';
    ctx.lifecycle.logout();
    return 'Logging out - you will need to scan a new QR to reconnect.';
  },
};
