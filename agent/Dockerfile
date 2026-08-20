# The Gateway/Agent process — a separate, standalone Node process (never part
# of the backend's Nest runtime). Same multi-stage shape as backend/Dockerfile
# for consistency. Used for containerized Enterprise/local-topology testing
# only; the SaaS variant of this same image is what an installable SaaS
# client would eventually run too (locked architecture §3/§5 — one Gateway
# Core, profiled by runtime config, not two images).
#
# Build from the REPO ROOT so the workspace + shared package are in context:
#   docker build -f agent/Dockerfile -t dpdp-agent .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# --- build: install the whole workspace (dev deps needed to build) ----------
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY shared/package.json shared/
COPY agent/package.json agent/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY agent agent
RUN pnpm --filter @dpdp/shared build && pnpm --filter @dpdp/agent build

# --- runtime: prod deps only -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY agent/package.json agent/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/agent/dist agent/dist
WORKDIR /repo/agent

# No EXPOSE of a fixed port beyond documentation — GATEWAY_BIND_PORT is
# env-driven (see agent/README.md); 7071 is the default. The agent NEVER
# auto-binds 0.0.0.0 — a container deployment must explicitly set
# GATEWAY_BIND_HOST (see docker-compose.yml), and the agent itself prints a
# loud non-loopback warning when it does, exactly as it does outside Docker.
EXPOSE 7071
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.GATEWAY_BIND_PORT||7071)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
