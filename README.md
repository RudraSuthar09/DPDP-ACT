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

| Role                                                              | Used for                                                     | RLS                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------- |
| migration role — `dpdp` locally, `dpdp_owner` on managed Postgres | **migrations only** (`DATABASE_URL`) — DDL, never row access | n/a for DDL         |
| `dpdp_app` (`NOSUPERUSER NOBYPASSRLS`, never the table owner)     | **the app** (`APP_DATABASE_URL`)                             | **always enforced** |

This split matters: Postgres silently bypasses RLS for superusers and table
owners, so if the app connected as the migration/owner role the whole guarantee
would evaporate — and you'd never notice locally. The app connects as `dpdp_app`,
for which RLS is unconditional. The bootstrap migration creates `dpdp_app`
idempotently on local/CI; on managed Postgres you provision it out-of-band (see
[Managed Postgres](#managed-postgres-supabase--rds--cloud-sql)) and the migration
leaves it untouched.

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
- **`identity-peephole`** — pins the one deliberate exception to tenant scoping
  (below): the app role has **no** privileges on `app.user_directory`, the
  `resolve_login` function returns ids and nothing else, and knowing another
  tenant's user id still reads zero rows.

A leak throws a loud `❌ CROSS-TENANT ISOLATION FAILURE` banner. Verified end to
end against a real Postgres, including a negative check: disabling RLS on one
table turns the suite red.

## Identity (FR-IDN-01/02/03) — and the one cross-tenant table

Auth is implemented **in-app**, behind
[`IdentityProvider`](backend/src/modules/identity/provider/identity-provider.ts).
Not Keycloak/Auth0, because Stage 1 deploys as exactly two containers and
SSO/SCIM is Stage 2 (`FR-IDN-06`) — that interface is where a Keycloak or WorkOS
adapter lands when a prospect actually asks. Zero new dependencies: `scrypt`
(node:crypto) for passwords, RFC 6238 TOTP tested against the RFC's own vectors,
AES-256-GCM for the TOTP secret at rest.

**MFA is not optional.** No route returns a session in exchange for a password:
`/auth/login` returns a *challenge*, and only `/auth/mfa/verify` (or
`/auth/mfa/confirm` at enrolment) mints an access token. The two token types are
distinct and non-interchangeable — a challenge presented as a bearer token is
refused, which is what stops MFA being a suggestion.

**RBAC**: `@Roles(...)` gates routes, and a global `RolesGuard` enforces a
**read-only floor** — Auditor and Viewer are refused any unsafe HTTP method on
**unannotated** routes, so read-only is what a new handler gets by default.
Opt out deliberately (and greppably) with `@AllowReadOnly()`.

### The login chicken-and-egg

Seam S1 binds every query to the tenant from the JWT. At **login there is no JWT
yet** — so "find the user with this email" cannot run under a tenant context,
because the tenant is precisely what we're looking up. The resolution is one
narrow, auditable peephole rather than putting `users` outside RLS:

- **`app.user_directory`** (`email -> user_id, tenant_id, status`) is the only
  cross-tenant table on the platform. `dpdp_app` has **no privileges on it at
  all** — it cannot be read, written, or enumerated.
- The only way through is **`app.resolve_login(email)`**, a `SECURITY DEFINER`
  function taking an *exact* email and returning three ids. No credential
  material, no `LIKE`, no listing.
- It is reached through exactly one named method — `TenantDatabaseService.resolveLogin()`
  — rather than a generic untenanted `query()`, so a second exception has to be
  written where review will see it.
- Everything after that (password, MFA, role) runs inside `withTenantId()` under
  full RLS, and the directory is maintained by a **trigger** on `users`, so it
  cannot drift.

**Users are never hard-deleted** (platform rule, I4): `active -> suspended ->
removed`, where `removed` is a permanent tombstone. This is engine-enforced, not
convention — `app.apply_tenant_rls()` grants no `DELETE`, so there is no
privilege to build a delete route with.

## Seam S5 — the audit chain (FR-AUD-01/02/03, I4, R3)

Append-only, hash-chained evidence, written by **one interceptor** and never by a
service. It exists before any module writes data, because an audit trail is the
one thing you cannot backfill.

**How a normal mutation becomes a chained entry** — `POST /users/:id/status`:

1. `TenantContextMiddleware` verifies the JWT → tenant/user/correlation id in
   AsyncLocalStorage (S1). `RolesGuard` checks the role.
2. **`AuditInterceptor` opens the request's unit of work** — one transaction —
   and an empty annotation, then calls the handler.
3. `IdentityService.changeStatus` reads the user (**before**), updates it
   (**after**), and calls `auditContext.annotate({...})` with both, the target,
   and the reason. It never touches the audit log.
4. The interceptor assembles **one** entry from what it knows (who, when, from
   where, correlation id, outcome) plus what the service annotated (what, to
   whom, why, before, after) and appends it **on the same transaction**.
5. `COMMIT`. The change and its evidence become true together.

A `BEFORE INSERT` trigger computes `seq`, `prev_hash`, and `hash` from the head of
that tenant's chain, overwriting anything supplied — so the application cannot
forge a link even in principle. Chains are **per tenant**: a global one would be
unverifiable by the only party who needs to verify it, since RLS means they can
only see their own rows.

### No change without evidence

The interceptor owns the transaction so that a failed audit append **rolls the
business change back**. Written the obvious way — handler commits, then the entry
is appended separately — you get a log that is *usually* right, and a change with
no evidence is exactly the state I4 exists to prevent. Proven end to end: revoke
`EXECUTE` on `app.audit_append`, attempt a suspend, and the user stays active.

One consequence worth knowing: bookkeeping that must survive a *rejection* — the
failed-login counter — uses `withTenantIdDetached()`. Left in the request
transaction it would roll back with the 401, silently disabling lockout.

### Only the interceptor can write — three independent barriers

| Barrier | What it stops | Pinned by |
|---|---|---|
| `AuditModule` does not export `AUDIT_SINK` | A service **cannot inject** it — the app fails to boot | `audit.module.spec.ts` |
| `dpdp_app` has `SELECT` on `audit_log` and nothing else | Ad-hoc `INSERT` is `permission denied`; the only path is `app.audit_append()` | `audit-chain.isolation-spec.ts` |
| No file outside `src/modules/audit/` may name `audit_log`/`audit_append` | Fails the build, with a message telling you to annotate instead | `audit-write-path.spec.ts` |

Services contribute through `AuditContextService.annotate()`, which has no
database access at all: annotating cannot become writing.

Append-only is enforced by **trigger**, not just by grant — triggers fire for the
table owner and for superusers, so even a DBA's `UPDATE`/`DELETE`/`TRUNCATE`
raises.

### Verifying

`GET /audit/verify` (Owner/DPO/Auditor) walks the chain via
`app.verify_audit_chain()` and reports every break: a sequence gap, a broken
link, or an altered entry. The recomputation uses `app.audit_entry_hash` — the
same function the trigger used to write it, so the verifier checks the log rather
than whether two implementations agree about JSON formatting.

Edit one old row and its hash stops matching its contents. Repair that hash and
the break just **moves forward** to the next entry, because each entry commits to
the whole history behind it. Hiding one edit means rewriting every entry after
it, to the head. What that still cannot stop is an attacker with owner rights
rewriting the entire chain — which is what Stage 4's daily Merkle roots in S3
Object Lock answer, by putting the head somewhere the database cannot reach.

**Known gap:** a denial from `RolesGuard` is not recorded — guards run before
interceptors in Nest, so the handler is never reached. Recording those would need
a second writer, which R3 forbids. Failures raised inside handlers and services
(the last-Owner refusal, a bad MFA code, a wrong password) *are* recorded, as
`outcome='denied'`.

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

### Managed Postgres (Supabase / RDS / Cloud SQL)

On local Docker/CI the migration role owns the database and the bootstrap
migration provisions everything itself. On **managed** Postgres the database is
owned by the provider's admin role, so the migration role (`dpdp_owner`) cannot
create schemas/roles or issue database-level grants — and **must not be given
those powers just to make a migration pass**. Those are one-time provisioning
concerns, not schema-migration concerns.

So: run [`docs/managed-postgres-setup.sql`](docs/managed-postgres-setup.sql)
**once** as the admin (on Supabase: the SQL Editor, which runs as `postgres`).
It creates `dpdp_owner`/`dpdp_app`, the `app` schema owned by `dpdp_owner`, and
the database/`public`-schema grants. The bootstrap migration then detects each of
those is already provisioned and skips it with a `NOTICE`, so the same migration
runs unmodified on both local Docker/CI and managed Postgres.

> Gotcha worth knowing: Postgres checks the `CREATE` privilege on the database
> **before** the `IF NOT EXISTS` short-circuit, so a bare
> `CREATE SCHEMA IF NOT EXISTS app` errors with `permission denied for database`
> as a non-owner _even when the schema already exists_. That's why the migration
> gates the statement on `has_database_privilege(...)` rather than relying on
> `IF NOT EXISTS`.

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




Every time you sit down to work on this app, you only need to run one command in your VS Code terminal (making sure you are inside the DPDP-ACT folder):

bash
pnpm dev
That single command does all the heavy lifting for you:

It starts the Next.js Frontend at http://localhost:3000
It starts the NestJS Backend API at http://localhost:3001
It watches for any code changes you make and automatically reloads both servers.
When you're done working for the day, just click inside the terminal and press Ctrl + C to stop it. Then run pnpm dev again the next time you want to open it!