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

# Mirror the npm scripts: silence the node:sqlite experimental warning.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/whatsapp-main.js"]
