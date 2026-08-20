# Same multi-stage shape as backend/Dockerfile for consistency.
#
# Build from the REPO ROOT so the workspace + shared package are in context:
#   docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:3001 -t dpdp-web .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# --- build: install the whole workspace (dev deps needed to build) ----------
FROM base AS build
# Next.js bakes NEXT_PUBLIC_* vars into the client bundle at BUILD time — it
# must be the browser-reachable address (e.g. http://localhost:3001), never
# the in-network service name, since the browser calls it directly (this
# frontend has no server-side API proxy).
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Customer installation package phase: off by default (dev build is
# unaffected). The installer's own frontend image variant is built with
# --build-arg NEXT_PUBLIC_REQUIRE_ACTIVATION=true — see installer/scripts/package-images.ps1.
ARG NEXT_PUBLIC_REQUIRE_ACTIVATION=false
ENV NEXT_PUBLIC_REQUIRE_ACTIVATION=$NEXT_PUBLIC_REQUIRE_ACTIVATION
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY frontend frontend
RUN pnpm --filter @dpdp/shared build && pnpm --filter @dpdp/web build

# --- runtime: prod deps only -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/frontend/.next frontend/.next
# No frontend/public directory exists in this project (Next.js's public/ is
# optional) — nothing to copy. Add this line back if one is introduced later.
WORKDIR /repo/frontend
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["pnpm", "start"]
