# Shared image for both backend processes (API + worker). They run the same
# build; only the start command differs (dist/main.js vs dist/worker.js).
#
# Build from the REPO ROOT so the workspace + shared package are in context:
#   docker build -f backend/Dockerfile -t dpdp-api .
#
# No secret is ever an ARG or ENV here: every credential is supplied at
# RUNTIME (compose env_file locally; a secrets manager in production). The
# image is identical for every environment.

# Pinned to an exact Node release: reproducible builds, and the same Node the
# Windows Gateway installer ships (gateway-installer/scripts). Node 20 reached
# end-of-life in April 2026. Bump deliberately, not by whatever "latest" is
# on build day.
FROM node:22.17.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm comes from package.json's "packageManager" pin, via corepack.
RUN corepack enable
WORKDIR /repo

# --- build: install the whole workspace (dev deps needed to build) ----------
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY sdk/package.json sdk/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY backend backend
COPY sdk sdk
# The Consent SDK + consent-form widget are built HERE because the API serves
# them (main.ts: /consent-sdk/v1/*). Before this, the image never contained
# sdk/dist, so the embed snippet the Integration page hands to customers
# returned 404 from every containerised deployment.
RUN pnpm --filter @dpdp/shared build \
 && pnpm --filter @dpdp/consent-sdk build \
 && pnpm --filter @dpdp/api build

# --- runtime: prod deps only -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/backend/dist backend/dist
# main.ts resolves the SDK as <cwd>/../sdk/dist, i.e. /repo/sdk/dist.
COPY --from=build /repo/sdk/dist sdk/dist
# Migration SQL + node-pg-migrate (a runtime dependency, see
# backend/package.json): the same image can run migrations as a one-off task
# against a fresh database, with no source tree or host tooling.
COPY backend/migrations backend/migrations
# The official Amazon RDS CA bundle (all regions; includes the ap-south-1
# roots, valid to 2061+), for DATABASE_SSL_CA_FILE: the server certificate is
# VERIFIED against it, hostname included (src/database/pg-tls.ts). Pinned by
# SHA-256, so a build can never silently pick up a different file — when AWS
# publishes a new bundle the build fails here, deliberately, until the pin is
# updated (docs/aws-deployment.md, "Refreshing the RDS CA bundle"). A public
# CA list, not a secret. World-readable so the unprivileged user can read it
# (a remote ADD defaults to 0600).
ADD --chmod=0644 \
  --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/dpdp/certs/rds-global-bundle.pem
# ADD's --chmod also applies to the parent directories it creates, leaving
# them untraversable (0644) for the unprivileged user — so reset them to 0755.
# The one directory the app writes to inside the image: the CSV/Excel import
# evidence store when IMPORT_EVIDENCE_STORE=local (container-local; production
# uses s3 — see docs/aws-deployment.md). Owned by the unprivileged user below.
RUN chmod 0755 /opt/dpdp /opt/dpdp/certs \
  && mkdir -p /repo/backend/var && chown -R node:node /repo/backend/var
WORKDIR /repo/backend
# Not root. The official image's `node` user (uid 1000) — nothing here needs
# privileges, and a compromise of the process should not be a root shell.
USER node
EXPOSE 3001
# Uses Node's built-in fetch (no curl/wget in the slim base image). Only
# meaningful for the API — the worker has no HTTP port, so compose disables
# this healthcheck there.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Node is PID 1 directly (never via a shell or pnpm), so SIGTERM reaches the
# app and Nest's shutdown hooks run: in-flight requests finish, pg-boss stops
# gracefully, pools close. Override to `node dist/worker.js` for the worker.
CMD ["node", "dist/main.js"]
