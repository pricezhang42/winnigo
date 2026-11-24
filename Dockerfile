FROM node:22.23.3-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci
COPY . .
# The worker, migrations and operator commands run from scripts/ and need the production
# dependencies that Next's standalone output leaves out, so they are kept alongside it.
RUN npm run build && npm prune --omit=dev

FROM node:22.23.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=5173 WINNIGO_HOST=0.0.0.0 WINNIGO_AUTH_MODE=session WINNIGO_DATA_DIR=/data
# pg_dump and pg_restore for the database backup (scripts/backup-database.mjs), matching the
# PostgreSQL 17 server.
RUN apk add --no-cache postgresql17-client
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5173
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:5173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
