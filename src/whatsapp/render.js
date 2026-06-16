/**
 * Render the core's OutboundMessage into a Baileys send-content object. Safe
 * surface only: text, plus optional mentions. Buttons / lists / templates /
 * interactive are deliberately not produced (deprecated; ban risk for non-business
 * accounts). Pure - no socket.
 *
 * @param {string | { text: string, mentions?: string[] }} out
 * @returns {{ text: string, mentions?: string[] }}
 */
export function toContent(out) {
  if (typeof out === 'string') return { text: out };
  if (out && typeof out.text === 'string') {
    return out.mentions?.length ? { text: out.text, mentions: out.mentions } : { text: out.text };
  }
  return { text: String(out ?? '') };
}
