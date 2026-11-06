# Same multi-stage shape as backend/Dockerfile for consistency.
#
# Build from the REPO ROOT so the workspace + shared package are in context:
#   docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t dpdp-web .
#
# ONE IMAGE PER ENVIRONMENT. Next.js bakes NEXT_PUBLIC_* values into the
# browser bundle at build time, so the API address is fixed when this image is
# built. Those values are PUBLIC by definition — never pass a secret as a
# build arg here; anything in a NEXT_PUBLIC_ variable is readable by every
# visitor.

# Pinned to an exact Node release — see backend/Dockerfile.
FROM node:22.17.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# --- build: install the whole workspace (dev deps needed to build) ----------
FROM base AS build
# The browser-reachable API address (e.g. https://api.example.com), never an
# in-network service name: the browser calls it directly.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Customer installation package only: the first-run activation gate. Off by
# default. installer/scripts/package-images.ps1 builds its variant with true.
ARG NEXT_PUBLIC_REQUIRE_ACTIVATION=false
ENV NEXT_PUBLIC_REQUIRE_ACTIVATION=$NEXT_PUBLIC_REQUIRE_ACTIVATION
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY frontend frontend
RUN pnpm --filter @dpdp/shared build && pnpm --filter @dpdp/web build

# --- runtime: prod deps only -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/shared/dist shared/dist
# Owned by the runtime user: Next.js writes its cache under .next at runtime.
COPY --from=build --chown=node:node /repo/frontend/.next frontend/.next
# No frontend/public directory exists in this project (Next.js's public/ is
# optional) — nothing to copy. Add this line back if one is introduced later.
WORKDIR /repo/frontend
# Not root — see backend/Dockerfile.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
# Node as PID 1, not `pnpm start`: pnpm sat between the container runtime and
# Next.js, so SIGTERM on a deploy or scale-in did not reliably reach the
# server and every stop waited out the full kill timeout. Same command the
# package.json start script runs.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
