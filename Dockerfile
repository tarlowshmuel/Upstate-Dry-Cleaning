# Multi-stage Docker build for the @workspace/api-server.
# Targets Fly.io / Railway / any Docker host. Produces a small Node 24 image
# that runs the bundled Express server on $PORT.
#
# Build:   docker build -t upstate-api .
# Run:     docker run --rm -p 8080:8080 \
#            -e PORT=8080 \
#            -e DATABASE_URL=... \
#            -e SESSION_SECRET=... \
#            -e ADMIN_PASSWORD=... \
#            -e ADMIN_PHONE_NUMBER=... \
#            -e TWILIO_ACCOUNT_SID=... \
#            -e TWILIO_AUTH_TOKEN=... \
#            -e TWILIO_PHONE_NUMBER=... \
#            -e DRIVER_START_ADDRESS=... \
#            -e DRY_CLEANERS_ADDRESS=... \
#            -e CORS_ORIGIN=https://your-frontend.example.com \
#            upstate-api

ARG NODE_VERSION=24.4.0

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /repo

RUN corepack enable

# Copy lockfile + workspace manifests first so dependency install caches well.
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY artifacts/api-server/package.json artifacts/api-server/

# Install ALL workspace deps the api-server transitively needs.
RUN pnpm install --frozen-lockfile \
  --filter @workspace/api-server... \
  --filter @workspace/db... \
  --filter @workspace/api-zod...

# Copy sources for the api-server and its lib dependencies only.
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

# Build composite libs, then bundle the api-server with esbuild.
RUN pnpm run typecheck:libs \
 && pnpm --filter @workspace/api-server run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The esbuild bundle is self-contained; we only need the dist folder + a
# package.json so Node treats .mjs as ESM.
COPY --from=builder /repo/artifacts/api-server/dist ./dist
COPY --from=builder /repo/artifacts/api-server/package.json ./package.json

# Fly / Railway inject PORT at runtime; default to 8080 for local docker run.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
