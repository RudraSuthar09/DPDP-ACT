# DPDP Compliance Platform

A compliance operating system for India's Digital Personal Data Protection (DPDP)
Act. It sits _alongside_ a client's systems and helps them **prove** they handle
personal data lawfully — storing compliance metadata, never customer records.

> **Read [`CLAUDE.md`](CLAUDE.md) first** for the invariants (I1–I4), seams
> (S1–S5), and rules (R1–R6) that govern every decision. Full spec:
> [`docs/DPDP_Platform_Master_Build_Document.md`](docs/DPDP_Platform_Master_Build_Document.md).

This repository is the **Stage 1** skeleton: a NestJS modular monolith on a single
Postgres, a Next.js frontend, and a shared types package — on deliberately boring
infrastructure. **No business logic is implemented yet.**

## What's in the box

```
.
├── backend/          @dpdp/api — NestJS modular monolith (app + worker entrypoints)
│   ├── src/modules/   identity · inventory · consent · breach ·
│   │                   grievance · dprequest · audit · notify (empty skeletons)
│   ├── migrations/    node-pg-migrate SQL migrations
│   └── test/isolation/ cross-tenant isolation suite (R5) — proves Seam S1
├── frontend/         @dpdp/web — Next.js app (dashboard shell; portal & admin later)
├── shared/           @dpdp/shared — types, seam contracts, consent envelope
├── docs/             the master build document
├── docker-compose.yml   Postgres 16 + Redis (the entire Stage 1 infra)
├── .github/workflows/ci.yml   build · lint · typecheck · test · isolation
├── CLAUDE.md         context primer for every session
├── turbo.json · pnpm-workspace.yaml · tsconfig.base.json
```

> **`backend` and `frontend` are the two main folders.** `shared` is a small
> types-only package both depend on.

### Deliberately NOT here (per the master doc)

Kafka, ClickHouse, Temporal, Kubernetes, DB-introspection connectors, the on-prem
agent, and SSO/SCIM. Each arrives in a later stage, only when a trigger metric
forces it (rule R1). The seams (S2/S3/S4) exist now so those systems slide in
behind an interface later — touching ~zero business logic.

## Prerequisites

- **Node.js ≥ 20.11**
- **pnpm ≥ 9** (`corepack enable`)
- **Docker** (for Postgres + Redis)

## Quick start

```bash
# 1. Install dependencies (from the repo root)
pnpm install

# 2. Configure environment
cp .env.example .env          # then edit as needed

# 3. Start infrastructure (Postgres 16 + Redis)
pnpm infra:up

# 4. Build the shared package (needed by api & web) + everything else
pnpm build

# 5. Run database migrations
pnpm migrate:up

# 6. Run the stack in dev (api, worker, web — all in watch mode)
pnpm dev
```

Then:

- API health check → http://localhost:3001/health
- Web dashboard → http://localhost:3000

To run just one app: `pnpm --filter @dpdp/api dev`, `pnpm --filter @dpdp/web dev`,
or the worker with `pnpm --filter @dpdp/api dev:worker`.

## The two Stage 1 containers

Production runs **two containers from one image** (`backend/Dockerfile`):

- **app** → `node dist/main.js` (HTTP API)
- **worker** → `node dist/worker.js` (BullMQ jobs + deadline ticker, behind the
  `WorkflowRunner` seam S3)

Uncomment the `app` and `worker` services in `docker-compose.yml` to run them in
Docker alongside Postgres and Redis. **Still not Kubernetes** — two containers do
not need an orchestrator.

## Common commands

| Command                                         | What it does                           |
| ----------------------------------------------- | -------------------------------------- |
| `pnpm dev`                                      | Run all apps in watch mode (Turborepo) |
| `pnpm build`                                    | Build every package                    |
| `pnpm lint`                                     | ESLint across the workspace            |
| `pnpm typecheck`                                | `tsc --noEmit` across packages         |
| `pnpm test`                                     | Unit tests                             |
| `pnpm format` / `pnpm format:check`             | Prettier write / check                 |
| `pnpm infra:up` / `pnpm infra:down`             | Start / stop Postgres + Redis          |
| `pnpm migrate:up` / `pnpm migrate:down`         | Apply / roll back migrations           |
| `pnpm --filter @dpdp/api migrate:create <name>` | New SQL migration                      |

## Seam S1 — tenant context (how isolation is enforced)

Tenant isolation is enforced by the **Postgres engine (Row-Level Security)**, not
by `WHERE tenant_id = ?` in application code (invariant I3). The tenant flows:

```
JWT tenant_id claim   →   AsyncLocalStorage (per request)   →   Postgres session
   (at the edge)              (flows through async hops)          GUC on checkout
   middleware                 TenantContextService                runWithTenant()
```

**Two database roles, on purpose:**

| Role                                              | Used for                             | RLS                                    |
| ------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `dpdp` (owner/superuser)                          | **migrations only** (`DATABASE_URL`) | bypassed — DDL doesn't need row access |
| `dpdp_app` (`NOSUPERUSER NOBYPASSRLS`, not owner) | **the app** (`APP_DATABASE_URL`)     | **always enforced**                    |

This split matters: Postgres silently bypasses RLS for superusers and table
owners, so if the app connected as `dpdp` the whole guarantee would evaporate —
and you'd never notice locally. The app connects as `dpdp_app`, for which RLS is
unconditional. The bootstrap migration creates `dpdp_app` idempotently.

**Every tenant table** (from migration #1) has a `tenant_id` and is turned
RLS-enforced by one helper, so the rule is identical everywhere and can't be
forgotten per table:

```sql
SELECT app.apply_tenant_rls('public.organisations');
-- ENABLE + FORCE RLS, and:
--   CREATE POLICY tenant_isolation USING      (tenant_id = app.current_tenant())
--                                 WITH CHECK  (tenant_id = app.current_tenant());
```

**How the GUC is set on checkout, and why it's guaranteed before any query.**
All tenant queries go through `runWithTenant(pool, tenantId, fn)`
([`backend/src/database/tenant-connection.ts`](backend/src/database/tenant-connection.ts)),
which, per unit of work:

1. checks out a pooled connection,
2. `BEGIN`s a transaction,
3. sets the GUC as the **first statement** —
   `SELECT set_config('app.current_tenant', $1, true)` — then
4. runs `fn` against **that same client**, and `COMMIT`s (or `ROLLBACK`s).

- **Guaranteed set before any query:** the GUC is the first statement on the very
  connection `fn` receives, so no query `fn` runs can precede it.
- **No leakage between requests:** `set_config(…, is_local => true)` is the
  parameterised form of `SET LOCAL` — scoped to the transaction and cleared on
  COMMIT/ROLLBACK, so a connection returned to the pool never carries a stale
  tenant to the next borrower.
- **No optional tenant / fail closed:** `TenantDatabaseService.withTenant()` reads
  the tenant from AsyncLocalStorage via `getOrThrow()` and throws if absent —
  before any DB work. And if a query ever runs with no GUC set,
  `app.current_tenant()` is `NULL`, so `tenant_id = NULL` matches nothing and the
  table returns zero rows. There is no code path where tenant is optional.

### The cross-tenant isolation suite (R5, NFR-SEC-05)

This suite protects the only promise the product sells, so it runs on **every
PR** and fails CI loudly on any leak. It connects as `dpdp_app`, seeds two
tenants, and — acting as tenant A — tries every way to read tenant B's data.
[`backend/test/isolation/`](backend/test/isolation/):

- **`rls-preconditions`** — verifies the suite can't pass _vacuously_: the role
  is not superuser and not `BYPASSRLS`, and **every** `public` table that has a
  `tenant_id` has RLS enabled **and** forced **and** a policy. (Add a tenant
  table without `app.apply_tenant_rls()` and this test fails.)
- **`cross-tenant-reads`** — positive controls (each tenant sees its own rows),
  the **forgotten-`WHERE`** headline test, a battery of malformed queries
  (tautologies, subqueries, JOINs, `CROSS JOIN`, `UNION`, CTEs, explicit
  `WHERE tenant_id = <B>`), **SQL-injection-style** attempts (parameterised and
  raw string-concatenation `OR '1'='1'`), aggregate/`EXISTS` existence probes,
  and fail-closed (no GUC, spoofed tenant). Every one returns **zero** B rows.
- **`cross-tenant-writes`** — cross-tenant `INSERT`/re-tenant `UPDATE` refused by
  `WITH CHECK`; a forgotten-`WHERE` `UPDATE` touches only the acting tenant; hard
  `DELETE` is denied outright (I4 — no `DELETE` grant).

A leak throws a loud `❌ CROSS-TENANT ISOLATION FAILURE` banner. Verified end to
end against a real Postgres, including a negative check: disabling RLS on one
table turns the suite red.

## Migrations — why `node-pg-migrate`, not Prisma Migrate

We picked **`node-pg-migrate`** (raw SQL migrations) over Prisma Migrate on
purpose:

- **The schema is Postgres-native, not ORM-native.** Stage 1 needs
  **Row-Level Security policies** on every table (S1/I3), **table partitioning**
  for the append-only consent store (S2), **hash-chain triggers** for the audit
  log (S5), and **bitemporal columns** (FR-CON-05). These are hand-written SQL
  DDL. Prisma Migrate is generated _from_ a Prisma schema that has no first-class
  way to express RLS policies, partitions, or triggers — you end up dropping to
  raw SQL escape hatches anyway, fighting the tool.
- **Migrations are evidence too (I4).** We want reviewable, explicit,
  version-controlled SQL — not a diff a generator produced.
- **No ORM lock-in at the isolation boundary.** Isolation is enforced by the
  database engine; the migration tool should get out of the way and let us write
  the exact policy. We use the `pg` driver directly.

Migrations live in [`backend/migrations/`](backend/migrations/) as `.sql` files
with `-- Up Migration` / `-- Down Migration` sections. The first one establishes
the `app.current_tenant()` helper that every RLS policy will use.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and PR:
format check → lint → typecheck → build → migrate → test → **cross-tenant
isolation suite** (R5 / NFR-SEC-05), against real Postgres + Redis service
containers. Migrations run as the owner role; the isolation suite connects as
`dpdp_app` (`APP_DATABASE_URL`) so it exercises RLS exactly as production does.

## Tech stack (Stage 1)

| Layer            | Choice                                                          |
| ---------------- | --------------------------------------------------------------- |
| Backend          | NestJS (TypeScript) — modular monolith, app + worker            |
| Database         | PostgreSQL 16 (RLS everywhere)                                  |
| Jobs / deadlines | BullMQ on Redis, behind `WorkflowRunner` (S3)                   |
| Frontend         | Next.js + React                                                 |
| Shared types     | `@dpdp/shared`                                                  |
| Migrations       | node-pg-migrate (raw SQL)                                       |
| Monorepo         | pnpm workspaces + Turborepo                                     |
| Tooling          | ESLint (flat config) + Prettier + TypeScript project references |
