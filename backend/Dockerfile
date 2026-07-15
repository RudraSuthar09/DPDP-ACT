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
WORKDIR /repo/backend
# Override to `node dist/worker.js` for the worker container.
CMD ["node", "dist/main.js"]
