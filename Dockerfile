# Production image for the WhatsApp bot: small, non-root, text-only (no media deps).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only - no dev deps, and no optional media deps (we send text).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Application source.
COPY src ./src

# Runtime data (auth session + sqlite) lives on a mounted volume, owned by `node`.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data

# Liveness: the app stamps data/health while connected; this reports the container unhealthy when
# that heartbeat goes stale (process wedged, or disconnected too long). The grace period covers the
# first connect / QR pairing. (In plain compose, unhealthy is shown by `docker ps`; pair an autohealer
# or an orchestrator to auto-restart on it - the reconnect cap already exits on unrecoverable states.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["node", "src/health-check.js"]

# Mirror the npm scripts: silence the node:sqlite experimental warning.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/whatsapp-main.js"]
