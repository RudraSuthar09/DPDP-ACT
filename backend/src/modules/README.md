# Backend modules

The modular monolith. Each folder is one bounded module. **Modules communicate
through service interfaces only and never reach into another module's tables
(R2)** — this is the entire reason a service split is possible later without a
rewrite.

| Folder      | Module                                             | Requirements            | Seams |
| ----------- | -------------------------------------------------- | ----------------------- | ----- |
| `identity`  | Identity & Tenancy                                 | FR-IDN-01..05           | S1    |
| `inventory` | Data Inventory                                     | FR-INV-01..11           | S4    |
| `consent`   | Consent Register                                   | FR-CON-01..09           | S2    |
| `breach`    | Breach Register                                    | FR-BRC-01..07           | S3    |
| `request`   | **Shared request substrate** (portal, OTP, handoff, SLA) | FR-GRV-01/03/04/05    | S1, S3, S5 |
| `grievance` | Grievance Register — complaints, on `request`       | FR-GRV-02/06/07         | S3    |
| `dprequest` | Data Principal Request Tracker — on `request`      | FR-DPR-01..09           | S3    |
| `audit`     | Audit & Evidence (hash-chained log)                | FR-AUD-01..05           | S5    |
| `notify`    | Email / SMS / signed webhooks                      | FR-DSH-02/03, FR-CON-07 | —     |

Add controllers, providers, and DTOs inside the module folder as features land.
Write consent, audit, and workflow rows **only** through the EventSink (S2) /
AuditSink (S5) / WorkflowRunner (S3) seams — never an ad-hoc `INSERT` (R3).

## `request` — the one module that is not a product module

`request` owns what Grievance (complaints, §13) and DPRequest (rights requests,
§§11–14) have in common, and nothing else: the public unauthenticated portal, the
OTP contact-channel proof, the **identity-verification handoff** (FR-GRV-04 — the
platform proves a channel, the tenant's own staff match the person), a generic
ticket with append-only lifecycle and correspondence trails, and SLA deadlines +
the escalation ladder through the WorkflowRunner (S3).

Both product modules call `RequestService`; neither extends it. Anything true of
only one of them — complaint categories, rights types, the two-tier Personal Data
Summary — belongs in that module's own tables, keyed by ticket id. The moment an
`if (requestType === 'grievance')` appears under `request/`, the substrate has
stopped being shared.

It is split in two on purpose: `RequestStoreModule` (repositories + escalation,
worker-safe) and `RequestModule` (controllers + services, imports
`IdentityModule`). Only the first may be imported by `worker.module.ts` — see the
header of `request-store.module.ts` for the boot-crash that split prevents.
