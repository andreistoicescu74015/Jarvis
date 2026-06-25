import { readFileSync } from 'node:fs';

/**
 * Load the owner's custom chatbot persona (Jarvis's voice in `ai on` mode) from a file. Returns the
 * trimmed file content, or '' when the path is unset, missing, or unreadable - in which case the
 * built-in voice is used. Best-effort by design: a bad path must never stop the bot from starting.
 * The file read happens once at the composition root; `read` is injectable so this stays unit-testable.
 *
 * @param {string} [path]  Filesystem path to the persona text (e.g. JARVIS_PERSONA_FILE).
 * @param {{ read?: (path: string, encoding: string) => string }} [opts]
 * @returns {string}
 */
export function loadPersona(path, { read = readFileSync } = {}) {
  if (!path) return '';
  try {
    return String(read(path, 'utf8')).trim();
  } catch {
    return '';
  }
}
