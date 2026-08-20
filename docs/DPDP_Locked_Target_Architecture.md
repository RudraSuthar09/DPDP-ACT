# DPDP Locked Target Architecture

> This file did not exist in the repository when this phase began. It is the
> repository-local record of the locked architecture decisions given for the
> "Enterprise Desktop Product" / deployment-model phase, and is now the
> authoritative reference alongside
> [DPDP_Platform_Master_Build_Document.md](DPDP_Platform_Master_Build_Document.md)
> and [CLAUDE.md](../CLAUDE.md) (read that one first — I1–I4/S1–S5/R1–R6
> still govern everything below; nothing here supersedes them).

## One product, two deployment variants

There is **one** DPDP core/codebase. Two installable deployment variants sit
on top of it:

1. **DPDP SaaS Instance** — an installable client component (SaaS Gateway +
   connector runtime) the customer runs, connecting their local
   databases/systems to the provider-managed DPDP cloud control plane.
2. **DPDP Enterprise Instance** — a fully installable DPDP application
   (Enterprise Gateway + connector runtime) deployed inside customer
   infrastructure (their AWS/Azure/on-prem/private cloud), communicating
   **outbound** to the provider control plane for licensing, registration,
   heartbeat, health, version, and permitted metadata sync.

Both share: DPDP core, identity, tenancy, RBAC, the five compliance modules,
Data Inventory, the data-source model, the licensing model, Gateway Core, and
the security model. The deployment variant is **runtime configuration and
capability**, never a fork.

## The non-negotiable data boundary (I1, unchanged)

Central PostgreSQL — the **existing** control-plane database, not a new one —
stores metadata/control-plane/compliance information: organisations, tenants,
users, roles, plans, licenses, installations, gateways, gateway
devices/sessions, data-source **metadata**, inventory metadata, purposes,
systems, vendors, retention metadata, consent, breach, grievance, DPR
records, audit/evidence metadata, notification metadata, health/version
metadata.

It **never** stores a customer database row, Aadhaar/PAN/phone/patient/
employee/financial value, a customer document, a database password, or a
secret connection string. Example: the platform may record `table=patients,
column=aadhaar, classification=personal_identifier` — never `aadhaar =
123456789012`. This is enforced today by `data_sources`' Mode A/B split (§4
below) and is unchanged by this phase.

## Plan / Deployment Type / Installation / License / Gateway / Data Source — kept separate

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Organisation | The customer/company | `organisations` |
| Tenant | The isolated DPDP workspace | `organisations.id` (== `tenant_id`, one org = one tenant, S1) |
| Plan | Commercial offering: `saas` \| `enterprise` | `organisations.plan` (descriptive default) or a `licenses.plan` (the actual entitlement once licensed) |
| Deployment Type | Technical model: `hosted` \| `client_server` | `organisations.deployment_type` (descriptive default) or `licenses.deployment_type` / `installations.deployment_type` (the actual entitlement/runtime fact) |
| Installation | A concrete deployed/running DPDP instance | `installations` (new — see below) |
| License | The central, server-enforced entitlement | `licenses` (new — see below) |
| Gateway | A registered device running the Gateway Core | `gateway_devices` (existing, now optionally linked to an `installations` row) |
| Data Source | A registered customer system, metadata only | `data_sources` (existing, untouched) |

```
Tenant (organisations)
  |
  +-- Installation (installations)
  |      |
  |      +-- Gateway (gateway_devices, via installation_id)
  |             |
  |             +-- Gateway Binding (implicit today: the DB-enforced
  |                    "one active device per tenant" rule + a data
  |                    source's data_access_mode='gateway_connected' —
  |                    not yet a separate table; data_sources.gateway_binding_ref
  |                    remains the placeholder for when it needs to be one)
  |                    |
  |                    +-- Data Source (data_sources)
  |
  +-- Compliance metadata (inventory, consent, breach, grievance, DPR, audit)
```

## Installation model

`installations`: `id`, `tenant_id`, `plan`, `deployment_type` (what this
specific instance was **licensed for** at registration — see below), `version`,
`status` (`active`/`inactive`/`decommissioned`), `environment_metadata`
(non-secret descriptive metadata only — never a customer value), `registered_at`,
`registered_by`, `last_heartbeat_at`. Tenant-scoped, RLS-forced, like every
other table.

Registration flow (`POST /installations`, staff-authenticated):

```
Install DPDP -> Enter License Key -> Central Control Plane
   -> Validate License (server-side, exact plan/deploymentType match)
   -> Register Installation -> Activate Correct Deployment Capabilities
```

The frontend never decides whether a license is valid — `InstallationService`
resolves the presented key, validates it against the requested
plan/deploymentType (`LicensingService.resolveAndValidate`), and only then
creates the row and activates the license against it.

## License model

`licenses`: `id`, `tenant_id`, `plan`, `deployment_type` (the entitlement),
`installation_id` (bound once activated), `license_key_hash` +
`license_key_prefix` (the raw key is shown once, at issuance, and **never**
stored — same discipline as `gateway_enrollments.code_hash`), `status`
(`pending`/`active`/`expired`/`revoked`), `features` (jsonb entitlement
overrides layered on plan defaults), `issued_at`, `expires_at`, `activated_at`,
`revoked_at`/`revoked_by`/`revoke_reason`.

An installation may register only with a plan/deployment_type that **exactly**
matches an active, unexpired, unrevoked license's — no mixing, no partial
grants (`licensing-policy.ts`'s `evaluateLicenseForActivation`, a pure,
independently unit-tested function).

## Capability model

The one centralized model (never scattered `if (plan === 'enterprise')`
checks). `GET /capabilities` returns:

```json
{
  "plan": "enterprise",
  "deploymentType": "client_server",
  "features": {
    "saas": false,
    "enterprise": true,
    "enterpriseGateway": true,
    "databaseConnectors": true,
    "localConnectors": true
  }
}
```

`CapabilityService.resolve()` derives this from the tenant's active license
when one exists, falling back to `organisations.plan`/`deployment_type`
otherwise (so every existing tenant — none of which have a license today —
keeps working exactly as before). `CapabilityService.assertCapability(key)` is
the **one** enforcement primitive; `CapabilityGuard`/`@RequireCapability(...)`
is a thin decorator over it for static per-route gating, and services call it
directly when the requirement depends on request data (e.g. linking a Gateway
device to a `client_server`-flavoured installation). Frontend hiding
(`frontend/src/lib/capabilities.ts`'s `useCapabilities()`) is UX only — the
backend guard/assertion is the actual security boundary.

## Gateway Core, profiled — not duplicated

```
DPDP Gateway Core (gateway.module.ts / .service.ts / .repository.ts —
unchanged, Phase 3C's enrollment/auth/device-identity/sessions/heartbeat/
connector-registry/audit implementation)
  |
  +-- SaaS Gateway Profile      (installation.deploymentType = 'hosted')
  |
  +-- Enterprise Gateway Profile (installation.deploymentType = 'client_server')
```

The profile is a **pure derivation** (`gateway-profile.ts`'s
`resolveGatewayProfile`), never a duplicated column or a second
implementation — surfaced on `GET /gateway/devices/active` once a device is
linked to an installation via the new, additive
`PATCH /gateway/devices/:id/installation`. Everything about enrollment,
pairing, sessions, heartbeat, and revocation is exactly as it was before this
phase.

## Mode A / Mode B (unchanged — the module was not touched)

Mode A (`metadata_only`, the default) stays introspection-only; Mode B
(`gateway_connected`) stays an explicit, role-gated, audited, fail-closed
configuration state that grants no raw-read capability by itself. Enforced by
`data_sources`' DTO rejection of `dataAccessMode` on create/update, the
dedicated `PATCH /:id/mode` route, and the structural guard specs
(`raw-access-guard.spec.ts`, `gateway-security-guard.spec.ts`,
`frontend-raw-data-boundary.spec.ts`) that fail the build if any raw-read
identifier/route is introduced. `SchemaSource` (S4) still has no `readRows()`
and never will.

## Docker / local deployment topologies

See `docker-compose.yml` and [environment-variables.md](environment-variables.md).
Plain Compose only (no Kubernetes this phase). Default profile: backend +
worker + frontend + agent against whatever `.env` already points at (hosted
Supabase today — unchanged). Optional `local-db` profile: a local Postgres 16
container for fully offline development.

```
Developer Machine
  |
  +-- DPDP SaaS/Enterprise (frontend + backend + worker containers)
  |     |
  |     +-- Gateway/Agent (agent container, GATEWAY_BIND_HOST=0.0.0.0
  |            |            inside the Compose network)
  |            +-- Test customer/enterprise DB (customer's own —
  |                 not part of this Compose file; point GATEWAY_SOURCES /
  |                 the agent's connector config at it, exactly as outside
  |                 Docker)
  |
  +-- DPDP Control Plane (backend + worker)
        |
        +-- Central PostgreSQL (existing Supabase, or the optional
             local-db profile)
```

`scripts/deployment-topologies-e2e.mjs` exercises both the SaaS and
Enterprise topologies end-to-end (real embedded Postgres, real agent
process, real HTTP API) — the established pattern this repo already uses for
Gateway E2E proof (`gateway-endpoint-e2e.mjs`, `consent-customer-resolution-e2e.mjs`),
rather than a new Docker-only test harness.

## Cloud-neutral by construction

Nothing in `docker-compose.yml`, the Dockerfiles, or the application code
names AWS or Azure. The logical shape (`Customer Installation --outbound
HTTPS/mTLS--> Provider Control Plane --> Central PostgreSQL`) is what a later,
separately-approved phase would deploy to ECS/EKS/App Runner or Container
Apps/AKS/App Service — a pure infrastructure decision, not something this
repository's business logic should ever branch on.

## What this phase deliberately did not do

- No `gateway_bindings` table — the binding between a Gateway and a Data
  Source stays implicit (the DB-enforced one-active-device-per-tenant rule +
  `data_access_mode`), same as today; introducing a real table is a future,
  separately-scoped decision if multi-Gateway-per-tenant is ever needed.
- No expansion of the pre-existing hostile cross-tenant-writes/reads battery
  (`backend/test/isolation/cross-tenant-*.isolation-spec.ts`) to
  `gateway_devices`/`data_sources`/older tables — that gap predates this
  phase and is out of scope for it.
- No AWS/Azure deployment, no Kubernetes manifests, no cloud-provider SDK
  dependency.
- No mTLS/code-signing/production hardening for the Gateway/Agent — still
  the loopback-by-default, explicitly-configured-otherwise model from Phase
  3B/3C.
