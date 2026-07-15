# CLAUDE.md — DPDP Compliance Platform

> Context primer for every working session. The full source of truth is
> [docs/DPDP_Platform_Master_Build_Document.md](docs/DPDP_Platform_Master_Build_Document.md).
> Read this file first; open the master document for detail. Requirement IDs
> (`FR-INV-09`, `S2`, `I3`, …) are stable — pin every task to one.

## What this is, in one sentence

A **compliance operating system for India's DPDP Act**. It sits _alongside_ a
client's systems and helps them _prove_ they handle personal data lawfully.

> **The one rule everything defers to:** _Business data stays with the client.
> Compliance data lives on the platform._ The platform stores metadata, events,
> tickets, and logs — **never customer records**. This is not a preference; it is
> the product.

## Where we are

**Stage 1 — The Working Product.** Boring infrastructure only: a **NestJS modular
monolith** on a **single PostgreSQL 16** database, jobs/deadlines on **Redis
(BullMQ)**, a **Next.js** frontend, deployed as **two containers (app + worker)**.

**Explicitly NOT in Stage 1** (they arrive later, only when a trigger metric forces
them — see R1): **Kafka** (Stage 3), **ClickHouse** (Stage 4), **Temporal**
(Stage 5), **Kubernetes** (Stage 3), **DB introspection connectors / on-prem
agent** (Stage 6), **SSO/SCIM** (Stage 2). Do not add them. Do not add
microservices — ever, forcibly.

## The four invariants (I1–I4) — if a feature can't honour these, it doesn't ship

- **I1 — Never store customer records.** Only metadata, categories, events,
  tickets, logs. There is no code path that reads a customer row. Connectors are
  introspection-only, permanently.
- **I2 — Customer references are pseudonymised and irreversible to the platform.**
  The client's internal customer ID is HMAC'd with a per-tenant secret. The client
  can re-derive it (they hold the ID); the platform never can.
- **I3 — Tenant isolation is absolute.** Enforced by the **database engine
  (Postgres Row-Level Security)**, never by application code alone. A forgotten
  `WHERE` clause or a SQL injection must still return zero rows from other tenants.
- **I4 — Everything stored is evidence.** Append-only, hash-chained, versioned.
  Nothing is overwritten or hard-deleted. Every write carries actor, timestamp,
  reason, before-state, after-state.

## The five seams (S1–S5) — build these now; the systems behind them come later

A seam is a place you can cut without bleeding: a simple interface today, a big
system behind it tomorrow. **Build the seams now, build the systems later.**

- **S1 — Tenant context.** Postgres RLS on every table from migration #1. Tenant
  from JWT → async-local context → Postgres session GUC on connection checkout.
  Later: schema-per-tenant → dedicated DB. Retrofit cost: **catastrophic.**
- **S2 — `EventSink` interface.** Consent events written through one interface.
  Stage 1 impl: append-only, partitioned Postgres table. Later: publishes to Kafka,
  fans out to Postgres + ClickHouse. Retrofit cost: **severe.**
- **S3 — `WorkflowRunner` interface.** Deadlines/SLAs run through one interface.
  Stage 1 impl: jobs table + BullMQ worker + deadline ticker. Later: Temporal.
  Shared by Breach, Grievance, and DPRequest (same physics). Retrofit cost: **severe.**
- **S4 — `SchemaSource` interface — with NO `readRows()`.** Only `ManualEntry` and
  `FileImport` implementations exist in Stage 1. `readRows()` must never exist in
  the contract, so no connector can ever exfiltrate customer data — I1 enforced by
  the type system. Later: DB drivers, SaaS adapters, on-prem agent.
- **S5 — Audit interceptor.** Hash-chained, append-only Postgres table, written by
  **one interceptor** — never by individual services. Later: ClickHouse + daily
  Merkle roots in S3 Object Lock. Retrofit cost: **impossible** — you cannot
  backfill an audit trail.

## The "never" rules (R1–R6) — the rules that keep this honest

- **R1 — Never cross a stage boundary without a trigger metric.** "The architecture
  feels incomplete" is not a trigger; a p99 latency number is. Premature Kafka has
  killed more startups than missing Kafka ever has.
- **R2 — Never let a module reach into another module's tables.** Service interfaces
  only. This is the entire reason a service split is possible later.
- **R3 — Never write an ad-hoc `INSERT`** into consent, audit, or workflow tables.
  Everything goes through the sink (S2) / runner (S3) / interceptor (S5). One
  exception, once, and the seam is gone.
- **R4 — Never build a connector before a paying customer names that specific
  database.**
- **R5 — Never skip the cross-tenant isolation suite** (`NFR-SEC-05`) — even in
  Stage 0. It runs on every PR and protects the only promise we actually sell.
- **R6 — Never store customer data "just temporarily."** There is no such thing.
  One row of patient data in our DB and the product's premise — and legal position
  — is dead.

## The five modules

| Module                         | Backend module | Stores                                                              |
| ------------------------------ | -------------- | ------------------------------------------------------------------- |
| Data Inventory                 | `inventory`    | Categories of data, purposes, retention — descriptions, not records |
| Consent Register               | `consent`      | Append-only, bitemporal consent events (HMAC'd subject refs)        |
| Breach Register                | `breach`       | Incident workflows, versioned deadline policies, evidence hashes    |
| Grievance Register             | `grievance`    | Complaint tickets on the shared portal/SLA substrate                |
| Data Principal Request Tracker | `dprequest`    | Rights requests + two-tier Personal Data Summary                    |

Cross-cutting backend modules: `identity` (tenancy, auth, RBAC), `audit` (S5
interceptor + hash chain), `notify` (email/SMS/webhooks).

> Grievance handles **complaints** (Act §13); DPRequest handles **rights requests**
> (§§11–14, above all the right to access). They share one substrate — portal, OTP,
> identity-verification handoff, ticketing, SLA timers, webhooks — so DPRequest is a
> specialised workflow on shared foundations, not a second ticketing system.

## Architectural non-negotiables for day-to-day work

- **Tenant is never optional.** Every table has `tenant_id`; every query runs under
  an RLS session variable; every log line and trace span carries tenant +
  correlation ID.
- **Everything user-facing is versioned** (notices, inventory, policies, templates).
  **Nothing is hard-deleted** (soft-delete + tombstone; deleting _platform_ data is
  itself an audited, approval-gated event).
- **Deadlines are data, not code** (`FR-BRC-02`). No statutory timeline is ever
  hardcoded; each is a versioned configuration record validated by counsel.
- **We are a Data Processor.** Pseudonymised refs, IPs, and grievance correspondence
  _are_ personal data. Be exemplary.

## Migrations

Raw SQL migrations via **node-pg-migrate** (justification in the README). RLS
policies, table partitioning, hash-chain triggers, and bitemporal columns are all
hand-written SQL — never an ORM's inferred schema.
