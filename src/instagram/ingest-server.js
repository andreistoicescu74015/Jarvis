import http from 'node:http';
import { nullLogger } from '../core/log.js';

/**
 * The one inbound socket Jarvis exposes: a tiny HTTP endpoint the Instagram sidecar PUSHES events to
 * (`POST /ig/inbound`). Jarvis is otherwise a pure outbound client, so this is deliberately minimal
 * and token-gated; the body is handed straight to `bridge.ingest` and the server owns no logic. Bind
 * it to the internal Docker network (do not publish the port to the host) and set a shared token.
 *
 * @param {{ bridge: { ingest: (event: object) => Promise<unknown> }, token?: string, host?: string, port?: number, log?: import('../core/log.js').Logger }} opts
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createIngestServer({ bridge, token = '', host = '0.0.0.0', port = 8765, log = nullLogger }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ig/inbound') {
      res.writeHead(404);
      return res.end();
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end();
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // an inbound DM event is tiny; cap to refuse abuse
    });
    req.on('end', async () => {
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      try {
        await bridge.ingest(event);
        res.writeHead(204);
        res.end();
      } catch (err) {
        log.error('ig: ingest failed', { error: err?.message ?? String(err) });
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.on('error', (err) => log.error('ig: ingest server error', { error: err?.message ?? String(err) }));

  return {
    start: () => new Promise((resolve) => server.listen(port, host, resolve)),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
