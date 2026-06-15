/**
 * Parse a raw message into a command invocation, if it is addressed to the bot.
 * Returns null when the text does not start with the prefix.
 *
 * @param {string} text
 * @param {string} [prefix='jarvis']
 * @returns {{ command: string, args: string[], rest: string } | null}
 */
export function parse(text, prefix = 'jarvis') {
  const trimmed = (text ?? '').trim();
  const lower = trimmed.toLowerCase();
  const p = prefix.toLowerCase();
  if (lower !== p && !lower.startsWith(`${p} `)) return null;

  const after = trimmed.slice(prefix.length).trim();
  if (!after) return { command: '', args: [], rest: '' };

  const parts = after.split(/\s+/);
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1),
    rest: after.slice(parts[0].length).trim(),
  };
}
