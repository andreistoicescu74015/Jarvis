/**
 * Parse a raw message into a command invocation, if it is addressed to the bot.
 * A message is addressed when its text starts with the prefix, OR when the caller
 * passes `addressed: true` (the platform already decided - e.g. an @mention - and
 * the text is a bare command with no prefix). Returns null otherwise.
 *
 * @param {string} text
 * @param {string} [prefix='jarvis']
 * @param {{ addressed?: boolean }} [opts]
 * @returns {{ command: string, args: string[], rest: string } | null}
 */
export function parse(text, prefix = 'jarvis', { addressed = false } = {}) {
  const trimmed = (text ?? '').trim();
  const lower = trimmed.toLowerCase();
  const p = prefix.toLowerCase();
  const hasPrefix = lower === p || lower.startsWith(`${p} `);
  if (!hasPrefix && !addressed) return null;

  const after = hasPrefix ? trimmed.slice(prefix.length).trim() : trimmed;
  if (!after) return { command: '', args: [], rest: '' };

  const parts = after.split(/\s+/);
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1),
    rest: after.slice(parts[0].length).trim(),
  };
}
