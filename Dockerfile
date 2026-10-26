# syntax=docker/dockerfile:1
# Pin the patched Node.js LTS baseline (security releases from 2026-10-21,
# incl. CVE-2026-111497). The floating node:24-alpine tag is not reproducible
# and can keep using an older cached base image on existing hosts.
FROM node:24.22.1-alpine

LABEL org.opencontainers.image.title="HomeDeck" \
      org.opencontainers.image.description="Self-hosted homelab dashboard with live stats, media info and deep .arr integrations" \
      org.opencontainers.image.source="https://github.com/thebeatmv1998/Landingpage" \
      org.opencontainers.image.licenses="MIT" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/thebeatmv1998/Landingpage/master/public/icons/homedeck.png"

WORKDIR /app

# su-exec lets the entrypoint drop to UID/GID (linuxserver-style UID/GID/UMASK/TZ)
RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Container conventions: app listens on 8000, persistent data in /data.
# (Both overridable via ENV PORT / DATA_DIR; bare-node installs use ./data on 8080.)
ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8000}/api/ping" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
