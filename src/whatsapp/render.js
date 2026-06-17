import { toWhatsApp } from '../core/format.js';

/**
 * Render the core's OutboundMessage into a Baileys send-content object. Safe
 * surface only: text, plus optional mentions. Buttons / lists / templates /
 * interactive are deliberately not produced (deprecated; ban risk for non-business
 * accounts). The reply's neutral markup is rendered to WhatsApp formatting here, at
 * the platform boundary. Pure - no socket.
 *
 * @param {string | { text: string, mentions?: string[] }} out
 * @returns {{ text: string, mentions?: string[] }}
 */
export function toContent(out) {
  if (typeof out === 'string') return { text: toWhatsApp(out) };
  if (out && typeof out.text === 'string') {
    const text = toWhatsApp(out.text);
    return out.mentions?.length ? { text, mentions: out.mentions } : { text };
  }
  return { text: toWhatsApp(String(out ?? '')) };
}
