// Container HEALTHCHECK entry point. The bot writes a heartbeat (epoch ms) to JARVIS_HEALTH_FILE while
// it is connected to WhatsApp; this exits 0 if that heartbeat is recent, 1 otherwise. Docker marks the
// container unhealthy on repeated non-zero exits. Keep this dependency-light (no sqlite) so it runs fast.
import { readFileSync } from 'node:fs';
import { isFresh } from './health.js';

const path = process.env.JARVIS_HEALTH_FILE ?? 'data/health';
const maxAgeMs = Number(process.env.JARVIS_HEALTH_MAX_AGE_MS) || 120_000;

let healthy = false;
try {
  healthy = isFresh(readFileSync(path, 'utf8'), Date.now(), maxAgeMs);
} catch {
  healthy = false; // missing/unreadable heartbeat -> not healthy
}
process.exit(healthy ? 0 : 1);
