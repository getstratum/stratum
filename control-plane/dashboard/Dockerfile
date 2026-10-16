# syntax=docker/dockerfile:1.7
# Stratum control plane (Next.js standalone build), runs as a non-root user.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly what the lockfile says, nothing newer.
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are baked into the browser bundle at build time.
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:20128
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# The account CLI (scripts/stratum-admin.mjs) and the modules it imports;
# pg is already in the standalone output.
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/lib/password.js /app/lib/totp.js /app/lib/secrets.js ./lib/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
