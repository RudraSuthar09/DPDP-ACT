# Shared image for both Stage 1 containers (app + worker). They run the same
# build; only the start command differs (main.js vs worker.js).
#
# Build from the REPO ROOT so the workspace + shared package are in context:
#   docker build -f backend/Dockerfile -t dpdp-api .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# --- build: install the whole workspace (dev deps needed to build) ----------
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY backend backend
RUN pnpm --filter @dpdp/shared build && pnpm --filter @dpdp/api build

# --- runtime: prod deps only -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/backend/dist backend/dist
# Migration SQL + node-pg-migrate (now a runtime dependency, not dev-only —
# see backend/package.json) so a self-contained installer/runtime image can
# migrate its own fresh local Postgres without needing the source tree,
# pnpm, or any host tooling. Unused by the existing dev workflow, which
# still runs `pnpm migrate:up` from the host against Supabase unchanged.
COPY backend/migrations backend/migrations
WORKDIR /repo/backend
# Uses Node's built-in fetch (no curl/wget in the slim base image). Only
# meaningful for the "app" container (GET /health) — the worker container
# has no HTTP port, so compose disables this healthcheck there.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Override to `node dist/worker.js` for the worker container.
CMD ["node", "dist/main.js"]
