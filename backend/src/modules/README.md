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
| `grievance` | Grievance Register (+ shared portal/SLA substrate) | FR-GRV-01..07           | S3    |
| `dprequest` | Data Principal Request Tracker                     | FR-DPR-01..09           | S3    |
| `audit`     | Audit & Evidence (hash-chained log)                | FR-AUD-01..05           | S5    |
| `notify`    | Email / SMS / signed webhooks                      | FR-DSH-02/03, FR-CON-07 | —     |

Each module is currently an empty `@Module({})` registered in
[`app.module.ts`](../app.module.ts). Add controllers, providers, and DTOs inside
the module folder as features land. Write consent, audit, and workflow rows
**only** through the EventSink (S2) / AuditSink (S5) / WorkflowRunner (S3) seams —
never an ad-hoc `INSERT` (R3).
