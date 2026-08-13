# DPDP Compliance Platform — Master Build Document

**Version 1.0 · Definitive · Self-contained**

> **Purpose of this document.** This is the single source of truth for building the platform. It contains the product definition, the full requirement set, the target architecture, the technology choices, and the detailed stage-by-stage implementation plan. It is written to be **read cold** — someone (or an AI assistant) starting with only this file has everything needed to begin work. No other document is required.

---

## PART 0 — How to use this document

**If you are starting a new working session**, paste or attach this document and state your stage and task, e.g.:

> *"I'm building the DPDP Compliance Platform described in the attached master document. I'm in **Stage 1**, working on **FR-CON-03 (consent event ingestion)**. Help me design the event envelope schema."*

Requirements carry stable IDs (`FR-INV-01`, `NFR-SEC-04`, `S2`, etc.) so any future task can be pinned to a specific line of this plan.

**Reading order for a newcomer:** Part 1 (what it is) → Part 2 (invariants — the four rules that govern everything) → Part 5 (the stage you're in). Parts 3, 4 and 6 are reference material.

---

## PART 1 — Product definition

### 1.1 What this software is, in one sentence

A **compliance operating system for India's Digital Personal Data Protection (DPDP) Act.** It does not replace a company's website, app, CRM, ERP, or database. It sits alongside those systems and helps the company *prove* it is handling personal data the way the law requires.

The analogy that lands with non-technical buyers: **GitHub does not write your code — it tracks versions and changes. Jira does not build your product — it tracks tasks and workflow.** This platform does not own or store a client's customer data — it tracks how that data is collected, protected, and governed.

### 1.2 The one rule everything is built on

> **Business data stays with the client. Compliance data lives on the platform.**

A hospital, shop, or clinic keeps using its own website, app, and database exactly as before. The platform never becomes a second copy of their customer list. It stores only small pieces of information about *how* that data is handled — never the data itself.

**This is not a design preference. It is the product.** It is the reason a hospital will sign, the reason the security review passes, and the reason the platform's own breach exposure is metadata rather than patient records. Every technical decision in this document defers to it.

### 1.3 The four layers

```
┌─────────────────────────────────────────────────────────────┐
│  CLIENT'S EXISTING SYSTEMS                                  │
│  Website · App · CRM · Database · Excel sheets              │
└─────────────────────────────────────────────────────────────┘
              │  only metadata & short events
              │  (never actual customer records)
              ▼
┌─────────────────────────────────────────────────────────────┐
│  THE PLATFORM — the compliance operating system             │
│  ┌───────────┬───────────┬───────────┬───────────┐          │
│  │   Data    │  Consent  │  Breach   │ Grievance │          │
│  │ Inventory │ Register  │ Register  │ Register  │          │
│  └───────────┴───────────┴───────────┴───────────┘          │
└─────────────────────────────────────────────────────────────┘
              │  dashboards, audit trails, notices, portal links
              ▼
┌─────────────────────────────────────────────────────────────┐
│  CLIENT COMPANY  (the Data Fiduciary)                       │
└─────────────────────────────────────────────────────────────┘
       │  notices, responses          ▲  consent, grievances
       ▼                              │
┌─────────────────────────────────────────────────────────────┐
│  CLIENT'S CUSTOMERS  (the Data Principals)                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 The five modules, in plain words

The original concept document described four modules. Experience with the DPDP Act's *rights of Data Principals* (Sections 11–14) makes a fifth a first-class citizen: the right to access is distinct enough — and important enough — to earn its own module rather than being buried inside grievance handling.

| Module | What it is |
|---|---|
| **Data Inventory** | A record of what *categories* of personal data the company holds, why they collect it, and how long they keep it. It stores **descriptions, not customer records.** |
| **Consent Register** | A running log of every time a customer said yes or no to something — so the company can always prove what was agreed to, and when. |
| **Breach Register** | A guided checklist and tracker for what to do if personal data is lost, leaked, or stolen — including legally required deadlines and notifications. |
| **Grievance Register** | A ticketing system for **complaints** from customers about how their data is handled, so nothing is missed and everything is tracked to resolution. |
| **Data Principal Request Tracker** *(new)* | The dedicated home for the **rights requests** a person can make about their own data — above all, the **right to access**: "tell me what personal information of mine you hold and are using." Each request is tracked to on-time closure, and the platform can assemble and share a structured **summary of that person's personal data** — without ever holding the data itself. |

> **Grievance vs. Request Tracker — the clean split.** The DPDP Act itself separates a *grievance* (Section 13 — a complaint about how you're being treated) from a *rights request* (Sections 11–12 — access, correction, erasure; Section 14 — nomination). So the two modules divide cleanly: **the Grievance Register handles complaints; the Data Principal Request Tracker handles rights requests** (access, correction, erasure, nomination, portability, and withdraw-consent). They **share the same underlying machinery** — the public portal, OTP verification, the identity-verification handoff, ticketing, SLA timers, and fulfilment webhooks — so this is a specialised workflow on shared foundations, not a second ticketing system.

### 1.5 The reference walkthrough — ABC Healthcare

This scenario is the acceptance test for the whole product. If the platform does all six steps without ever storing a patient record, it works.

1. **Sign-up.** ABC Healthcare registers. The system creates a dedicated, private workspace (tenant) containing all five modules. Multi-tenant, fully isolated — no organisation can see another's data.
2. **Data Inventory.** The hospital documents the personal data it processes — via guided forms, an Excel/CSV import, or (optionally) a read-only database link. Even with a database connected, the platform examines **only the structure** (table and column names) to identify categories like names, phone numbers, emails. **It never copies patient records.**
3. **Consent.** A patient books an appointment on the hospital's website and agrees to reminders. The hospital stores the patient's information in its own database, as always. Simultaneously, a small JavaScript widget sends a compliance event to the platform containing **only**: organisation ID, an internal customer reference, the purpose, the consent status, and a timestamp.
4. **Breach.** A laptop with patient data is stolen. The compliance officer records the incident. The platform guides them through the workflow — documenting the incident, tracking regulatory deadlines, generating notification templates, maintaining an audit trail — **without ever touching the hospital's customer database.**
5. **Grievance.** A patient complains that they kept getting marketing messages after opting out. The complaint becomes a ticket assigned to the hospital's Grievance Officer, tracked to resolution with a full correspondence trail.
6. **Data Principal request.** A patient sends a formal request: *"Show me all the personal information ABC Healthcare holds about me."* The platform verifies the request, hands ABC's Grievance Officer a verification-and-fulfilment task, and tracks it against its statutory deadline. The platform assembles the parts it legitimately holds — **which categories** of the patient's data the hospital keeps, why, where, for how long, and the patient's full **consent and request history** — and orchestrates the hospital assembling the **actual data values** from its own systems. The patient receives one clean Personal Data Summary; the platform proves it was delivered on time — **without ever having stored the patient's records.**

**End result:** ABC Healthcare still owns all its customer data. The platform holds only data inventories, consent records, breach reports, grievance tickets, Data Principal request records, and audit logs.

### 1.6 "But every client has a different kind of database"

The platform is *almost never* touching the client's actual database. Information arrives in three ways, depending on how technical the client is:

- **Small businesses** — type it in, or upload an Excel/CSV. No technical connection at all.
- **Medium businesses** — connect a ready-made link to a system they already use (Shopify, Zoho CRM).
- **Larger/technical clients** — optionally give a **read-only** connection. Even then the platform looks only at table and column names (noticing a column called `Email`) — never the rows.

**Whichever path is used, what ends up stored is identical:** categories of data, consent events, breach records, grievance tickets. **The underlying database technology becomes irrelevant.** This is the key insight that makes the platform universally compatible — and it is why database connectors are the *last* thing built, not the first.

---

## PART 2 — The four invariants

Everything in this document derives from §1.2. These four invariants are the operational form of that rule. **If a feature or technology cannot honour them, it does not ship.**

| ID | Invariant | Engineering consequence |
|---|---|---|
| **I1** | The platform **never persists customer data values** — only metadata, categories, events, tickets, logs. Data access is **two-mode, per data source**: **Mode A (metadata-only, the default)** reads no customer row; **Mode B (Gateway-connected — explicit opt-in, role-gated, tenant-scoped, audited)** may read a raw value live and show it to an authorized user, **transiently only, never persisted**. | The metadata/introspection path (`SchemaSource`) is introspection-only, permanently, and has no code path that reads a customer row. Mode-B raw values never reach central PostgreSQL, application logs, audit annotations, error messages, or any durable/temp store — and Mode B never routes through `SchemaSource`. Enabling Mode B on one source grants nothing about any other source. See §2.1. |
| **I2** | Customer references are **pseudonymised and irreversible to the platform**. | The client's internal customer ID is HMAC'd with a per-tenant secret. The client can always re-derive it (they hold the ID). The platform can never reverse it. |
| **I3** | **Tenant isolation is absolute.** | Enforced by the *database engine* (Postgres Row-Level Security), never by application code alone. A forgotten `WHERE` clause or a SQL injection still returns zero rows from other tenants. |
| **I4** | **Everything stored is evidence.** | Append-only, hash-chained, versioned. Nothing is overwritten. Nothing is hard-deleted. Every write carries actor, timestamp, reason, before-state, after-state. |

**Why I4 matters more than it looks:** a compliance product that cannot reconstruct *"what did this look like on the day of the incident?"* is not a compliance product. It is a form.

### §2.1 — Data-access modes (Mode A / Mode B)

I1 is not "the platform can never see a raw value" — it is "the platform never *persists* one." Access to a client's data is a property of each **individual data source**, not of the tenant, and every source is one of two modes:

| | **Mode A — Metadata-only** | **Mode B — Gateway-connected** |
|---|---|---|
| **Default** | **Yes — every source starts here.** | No — explicit opt-in only. |
| **Reads raw values?** | Never. Structure/descriptions only. | Yes — live, for an authorized operation. |
| **How enabled** | (the default) | Per source, role-gated, tenant-scoped, audited. |
| **Persistence of raw values** | N/A (none are read) | **Never** — not in central PostgreSQL, logs, audit annotations, error messages, temp layers, or any durable store. Transient in memory for the operation only. |
| **Path** | `SchemaSource` (introspection-only, no `readRows()`) | A **separate Gateway capability** that never routes through `SchemaSource`. |

Consequences that are load-bearing and must not be blurred:

- **Per-source, not per-tenant.** A tenant may have *Source A → metadata_only* and *Source B → gateway_connected* simultaneously. Enabling Mode B on one source confers **no** access to any other source.
- **The metadata/introspection path stays Mode A forever.** `SchemaSource` must never gain a raw-value read method (`readRows()` or any equivalent). Mode B is built *beside* it, never *through* it.
- **Two existing mechanisms already embody the Mode-B discipline** and are the reference for anything new: **Tier 2** (`FR-DPR-05`) relays a client's values and forgets them (never persisted), and the **fulfilment record** (`dpr_fulfilments`) deliberately has no column that could hold a value. These remain unchanged; the Gateway is a *new transport* to the *same* rule, and Tier 2 stays as a supported, backward-compatible integration path.
- **Fail closed.** Absent or `metadata_only` mode ⇒ any raw read is refused.

---

## PART 3 — Requirements

### 3.1 Functional requirements

#### Identity & Tenancy (`FR-IDN`)

| ID | Requirement | Stage |
|---|---|---|
| FR-IDN-01 | Organisation self-registration creating an isolated tenant workspace | 0 |
| FR-IDN-02 | User authentication: email + password + MFA | 0 |
| FR-IDN-03 | Role-based access: Owner, DPO, Compliance Officer, Grievance Officer, Auditor (read-only), Viewer | 0 (basic) → 2 (granular) |
| FR-IDN-04 | Designation of DPO and Grievance Officer, published on the client's public portal page | 1 |
| FR-IDN-05 | Team invitations, user lifecycle (invite, suspend, remove — never hard-delete) | 1 |
| FR-IDN-06 | Enterprise SSO (SAML 2.0 / OIDC) and SCIM user provisioning | 2 |
| FR-IDN-07 | Tenant tiers: Standard (shared DB + RLS), Premium (schema-per-tenant), Enterprise (dedicated DB) | 6 |

#### Data Inventory (`FR-INV`)

| ID | Requirement | Stage |
|---|---|---|
| FR-INV-01 | Guided form entry of data elements (what is collected, why, where stored, how long retained) | 0 |
| FR-INV-02 | Excel/CSV import with a column-mapping UI and validation | 0 |
| FR-INV-03 | PII classification engine — rule/dictionary based, with **Indian-context lexicon**: Aadhaar, PAN, ABHA ID, UPI VPA, mobile, MRN, DOB, biometric markers | 0 |
| FR-INV-04 | Every classification is a **suggestion with a confidence score** that a human must accept or reject. Both the suggestion and the decision are audited. | 0 |
| FR-INV-05 | Processing purposes, legal basis, and retention rules linked to each data element | 1 |
| FR-INV-06 | Systems/assets register (where data lives) | 1 |
| FR-INV-07 | Third-party processor/vendor mapping (who else gets this data) | 1 |
| FR-INV-08 | Full version history — every edit creates a new version; nothing is overwritten | 0 |
| FR-INV-09 | **RoPA export (Record of Processing Activities) as PDF and XLSX** | 0 |
| FR-INV-10 | Data-flow visualisation: elements → purposes → recipients | 1 |
| FR-INV-11 | Sector templates (healthcare, retail, edtech, fintech) pre-seeding common data elements | 1 |
| FR-INV-12 | SaaS connectors (Zoho, Shopify, Salesforce…) importing **object/field definitions only** | 2 |
| FR-INV-13 | Read-only DB introspection — schema/catalog only, **never rows** | 6 |
| FR-INV-14 | On-premise agent for introspection inside private networks (outbound-only) | 6 |

> **FR-INV-09 is the single highest-leverage feature in the product.** It is the artefact a compliance officer would otherwise spend three weeks assembling by hand, and it is what closes the first sale. Build it in Stage 0.

#### Consent Register (`FR-CON`)

| ID | Requirement | Stage |
|---|---|---|
| FR-CON-01 | Consent purposes defined per tenant (e.g. "appointment reminders", "marketing email") | 1 |
| FR-CON-02 | **Notice management**: versioned notice text, per purpose, **multilingual** (DPDP requires notice availability in Eighth Schedule languages) | 1 |
| FR-CON-03 | Consent event ingestion via REST API and JavaScript SDK. Payload contains **only**: org ID, subject reference, purpose ID, status, timestamp — plus notice version ID, evidence hash, source, idempotency key. | 1 |
| FR-CON-04 | **Subject reference pseudonymisation** at ingest (per-tenant HMAC) — see I2 | 1 |
| FR-CON-05 | **Bitemporal, append-only storage.** A withdrawal is a *new event*, never an update. The system must answer *"what was true on 3rd March?"* forever. | 1 |
| FR-CON-06 | Consent withdrawal must be **as easy as granting it** (a DPDP requirement) — one click, from the SDK or the grievance portal | 1 |
| FR-CON-07 | Signed webhook to the client's system on any consent change, so *they* can act on it | 1 |
| FR-CON-08 | Proof-of-consent export: for a given subject reference and date, produce a certificate showing status, purpose, and the exact notice version shown | 1 |
| FR-CON-09 | Consent SDK: vanilla TypeScript, **< 5 KB gzipped**, zero dependencies, CDN-delivered, with Subresource Integrity hashes | 1 |
| FR-CON-10 | Mobile SDK wrappers (Android, iOS) and a React wrapper | 2 |
| FR-CON-11 | Consent analytics: grant/withdrawal rates by purpose over time | 4 |

> **Why FR-CON-02 and FR-CON-05 cannot be deferred:** consent divorced from the notice it was given against is worthless as evidence. And if you store consent as a mutable `status` column, you can never answer the only question the law actually asks. Retrofitting either one means re-versioning every consent record you ever wrote. **Most competing products get this wrong.**

#### Breach Register (`FR-BRC`)

| ID | Requirement | Stage |
|---|---|---|
| FR-BRC-01 | Incident intake form: what happened, when discovered, systems affected, data categories involved (drawn from the Data Inventory), estimated scope | 1 |
| FR-BRC-02 | **Deadline policies as versioned configuration records, not code.** Each regulation's timelines are data. | 1 |
| FR-BRC-03 | Guided workflow with gates: acknowledge → assess → notify Data Principals → notify the Board → remediate → RCA → closure with sign-off | 1 |
| FR-BRC-04 | Automatic deadline tracking with escalating alerts (in-app, email, SMS) as a deadline approaches | 1 |
| FR-BRC-05 | Notification template generation (Data Principal notice, regulator report), auto-populated from the incident record | 1 |
| FR-BRC-06 | Evidence upload with immutable storage and hash recording | 1 |
| FR-BRC-07 | Sealed closure packet: full timeline + notices sent + evidence hashes, exported as one PDF | 1 |
| FR-BRC-08 | Durable workflow execution surviving deploys, crashes, and outages | 5 |
| FR-BRC-09 | In-flight incidents continue under the deadline-policy version they started with; new incidents pick up the new version | 5 |

> **FR-BRC-02 is the requirement that keeps the product alive across a decade.** The DPDP Rules will be amended. When they are, you must be able to edit a row, not ship a release. Confirm all current statutory timelines with counsel — **this document deliberately does not hardcode numbers, and neither should the software.**

#### Grievance Register (`FR-GRV`)

Handles **complaints** — a Data Principal unhappy with how they've been treated (Section 13 of the Act). Rights requests (access, correction, erasure, nomination, portability) live in the Data Principal Request Tracker (`FR-DPR`) below. Both modules share the same portal, verification, ticketing, SLA, and webhook substrate (`FR-GRV-01`, `-03`, `-04`, `-05`).

| ID | Requirement | Stage |
|---|---|---|
| FR-GRV-01 | Public portal per tenant (branded, no login required to *submit*) — **shared by both this module and the Request Tracker** | 1 |
| FR-GRV-02 | Grievance/complaint intake and categorisation | 1 |
| FR-GRV-03 | Contact-channel verification via OTP (email/SMS) before a request proceeds — **shared substrate** | 1 |
| FR-GRV-04 | **The identity-verification handoff** — see below — **shared substrate** | 1 |
| FR-GRV-05 | Ticket lifecycle with assignment to the Grievance Officer, full correspondence trail, SLA timers, escalation ladder (Grievance Officer → DPO → escalation contact) — **shared substrate** | 1 |
| FR-GRV-06 | Resolution export: proof that a complaint was received, verified, actioned, and closed within the required time | 1 |
| FR-GRV-07 | Durable SLA workflows with guaranteed escalation | 5 |

> **FR-GRV-04, stated honestly:** the platform **cannot** verify that a requester is who they claim to be — because, by design, it holds no identities. So the flow is: portal receives the request → platform verifies *contact-channel ownership* (OTP) → platform hands the client a **verification task** → the client matches the requester against *their own* records → the workflow proceeds.
>
> **The platform orchestrates; the client identifies.** This preserves I1 and is the architecturally correct division of responsibility. Any vendor claiming to verify Data Principal identity without holding identity data is either storing customer data or lying. This handoff is used identically by the Request Tracker below.

#### Data Principal Request Tracker (`FR-DPR`)

The dedicated module for **rights requests** under Sections 11–14 of the DPDP Act. Its centrepiece is the **right to access** — a person formally asking the fiduciary what personal information of theirs is held and used — tracked to on-time closure, culminating in a shareable **Personal Data Summary**.

| ID | Requirement | Stage |
|---|---|---|
| FR-DPR-01 | Rights-request intake through the shared portal. Types: **access, correction, erasure, nomination, data portability, withdraw consent** | 1 |
| FR-DPR-02 | Each request is a tracked ticket on the shared ticketing/SLA/verification substrate (reuses `FR-GRV-01/03/04/05`) — assigned to the Grievance Officer / DPO, with the identity-verification handoff | 1 |
| FR-DPR-03 | **Statutory deadline tracking to on-time closure** — countdown, escalating alerts, and a visible SLA clock per request, driven by versioned deadline policies (same mechanism as `FR-BRC-02`) | 1 |
| FR-DPR-04 | **Personal Data Summary — Tier 1 (platform-held metadata).** For a verified subject reference, assemble automatically: which **categories** of the person's data the fiduciary holds, the **purposes**, the **systems/locations** and **retention**, plus the person's full **consent history** and **prior request history**. This is built entirely from Data Inventory + Consent Register + request records — data the platform legitimately holds. | 1 |
| FR-DPR-05 | **Personal Data Summary — Tier 2 (actual data values).** Orchestrate the client assembling the person's real records: fire a signed **fulfilment request** to the client's systems (webhook / manual task / — later — connector or agent); the client returns the data; the platform **relays or links it to the requester without persisting the raw payload** (relay-and-forget, or transient client-key-encrypted, or a secure one-time link). | 1 (manual/webhook) → 6 (automated via connectors) |
| FR-DPR-06 | **Subject-reference resolution without breaking I2.** The requester doesn't know their internal HMAC'd reference. The client supplies the raw customer ID during the verification handoff; the platform HMACs it to locate the matching consent/request records. The platform still never stores or reverses the raw ID. | 1 |
| FR-DPR-07 | **Combined Personal Data Summary export** (Tier 1 + the Tier-2 confirmation/package) as a single branded PDF, delivered to the verified requester | 2 |
| FR-DPR-08 | Fulfilment webhooks for correction/erasure/portability — on approval, fire a signed webhook; record the client's confirmation (the platform never edits or deletes customer data — it *proves* the action was requested, actioned, and confirmed) | 1 |
| FR-DPR-09 | Request register + evidence export: proof that every rights request was received, verified, fulfilled, and closed within the statutory window — the artefact the client shows a regulator | 1 |
| FR-DPR-10 | Durable SLA workflows for rights requests (moves onto the same engine as breach/grievance) | 5 |
| FR-DPR-11 | **Automated data-package assembly** — where a SaaS connector or the on-prem agent exists, help assemble the Tier-2 data package directly from the client's systems (still without persisting it), reducing the manual burden on the client's officer | 6 |

> **The honest architecture of "summarise all personal data" (the hard part):** the platform holds *metadata, not data*. So the summary comes in two tiers. **Tier 1** — the map of the person's data (categories, purposes, locations, retention, consent, request history) — the platform produces itself, because that's exactly what it legitimately holds. **Tier 2** — the actual values — live with the client; the platform *orchestrates* their assembly and *proves* on-time delivery, but does not become a copy of them. This is the same pattern as the erasure webhook (`FR-DPR-08`): the platform never performs the data action, it proves the data action happened. Preserving I1 here is not a limitation to apologise for — it *is* the product, and it's what lets a hospital say yes.

#### Audit & Evidence (`FR-AUD`)

| ID | Requirement | Stage |
|---|---|---|
| FR-AUD-01 | **Hash-chained append-only audit log.** Each entry contains the hash of the previous entry — any tampering breaks the chain. | 0 |
| FR-AUD-02 | Every entry records: who, what, when, from where, why, before-state, after-state, tenant, correlation ID | 0 |
| FR-AUD-03 | Written by **one interceptor**, never by individual services (see rule R3, Part 8) | 0 |
| FR-AUD-04 | Audit log is queryable and filterable in the dashboard | 1 |
| FR-AUD-05 | **Exportable verifiable evidence bundle** — what the client hands a regulator | 1 |
| FR-AUD-06 | Daily Merkle root of the chain sealed into WORM storage (S3 Object Lock) | 4 |

> **FR-AUD-01 cannot be retrofitted.** You cannot backfill an audit trail. A gap in your first year is a permanent hole in the evidence you sell. It costs a day to build now and is impossible to fix later.

#### Dashboard & Notifications (`FR-DSH`)

| ID | Requirement | Stage |
|---|---|---|
| FR-DSH-01 | Compliance dashboard: counters (inventory categories mapped, active consents, open breach incidents, open grievance tickets, **open data-principal requests**) + recent activity feed | 0 |
| FR-DSH-02 | Transactional email (deadline alerts, grievance acknowledgements, breach notices) | 1 |
| FR-DSH-03 | SMS/WhatsApp for OTP and urgent deadline escalation (India: MSG91 / Gupshup) | 1 |
| FR-DSH-04 | Compliance-health score and outstanding-task list | 2 |
| FR-DSH-05 | Sub-50ms dashboard load via pre-computed counters | 2 |

### 3.2 Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-SCA-01 | Consent ingest throughput | Stage 1: 100k events/month · Stage 6: 500M+/month |
| NFR-SCA-02 | Tenant count | Stage 1: 50 · Stage 6: 10,000+ |
| NFR-PRF-01 | API p95 latency | < 300 ms |
| NFR-PRF-02 | **Consent ingest p99 latency** | **< 100 ms** — this endpoint sits inside clients' checkout flows. Its slowness is *their* outage. |
| NFR-AVL-01 | Platform uptime | 99.9% |
| NFR-AVL-02 | Consent ingest endpoint uptime | **99.95%** — higher than the rest of the platform, for the reason above |
| NFR-SEC-01 | Encryption in transit | TLS 1.3 everywhere; mTLS between services and for the on-prem agent |
| NFR-SEC-02 | Encryption at rest | AES-256, **per-tenant data keys** wrapped by a KMS master key |
| NFR-SEC-03 | Field-level encryption | Grievance free-text, breach narratives, subject references |
| NFR-SEC-04 | Secrets | Vault; short-lived credentials; client DB creds never logged, never in env vars, always rotatable |
| NFR-SEC-05 | **Cross-tenant isolation testing** | Automated suite in CI that *attempts* unauthorised cross-tenant reads and must get zero rows. Runs on every PR. |
| NFR-SEC-06 | Penetration testing | Third-party test before GA, annually thereafter |
| NFR-RES-01 | **Data residency** | India-only regions (AWS Mumbai `ap-south-1` + Hyderabad `ap-south-2`). A sales requirement even where the law permits transfer. |
| NFR-DR-01 | Recovery point objective | ≤ 5 minutes |
| NFR-DR-02 | Recovery time objective | ≤ 1 hour, drilled quarterly |
| NFR-CMP-01 | Certification path | ISO 27001 → SOC 2 Type II |
| NFR-OBS-01 | Observability | OpenTelemetry; every span carries tenant + correlation ID; SLO-based alerting |

### 3.3 Explicitly out of scope

- The platform does **not** store, process, or host customer/business data.
- The platform does **not** delete customer data on erasure requests — it *proves the deletion was requested, actioned, and confirmed*. The client deletes.
- The platform does **not** verify Data Principal identity — the client does (FR-GRV-04).
- The platform does **not** become the copy-of-record for a person's actual data when fulfilling an access request. It produces the **Tier-1 summary** (categories, purposes, consent and request history — metadata it legitimately holds) and *orchestrates and relays* the **Tier-2 actual values** the client assembles, without persisting the raw payload (FR-DPR-04/05).
- The platform's audit trail proves **what the client recorded and when.** It cannot prove what happened inside the client's own systems.

> **State that last limitation plainly to clients.** Honest positioning is a competitive advantage here. Over-claiming is how compliance vendors get sued.

---

## PART 4 — The solution architecture

### 4.1 Target-state stack (where you end up, not where you start)

| Layer | Technology | Rationale |
|---|---|---|
| **Backend** | **TypeScript / NestJS** — modular monolith, selectively split | One language across API, SDK and frontend; fastest velocity for a small team; a monolith with clean module boundaries beats premature microservices every time |
| **Connectors / agent** | **Go** | Single static binary the client's IT team can run; excellent DB driver coverage; low memory |
| **Primary DB** | **PostgreSQL 16** + Row-Level Security + partitioning | Tenant isolation enforced by the engine; the safest thing to hand an enterprise security review |
| **Consent event store** | **ClickHouse** | Consent is append-only time-series. 10–100× compression; sub-second "prove consent as of date X" at billions of rows |
| **Event bus** | **Kafka** (managed) | Decouples the consent firehose from the database. Absorbs spikes; enables replay — replay is itself an audit feature |
| **Workflow engine** | **Temporal** | Breach and grievance deadlines are durable, multi-day, must-not-be-lost state machines |
| **Cache / jobs** | **Redis** | Counters, sessions, idempotency keys, rate limits |
| **Evidence store** | **S3 + Object Lock (WORM)** | Makes "we could not have tampered with it" a *provable* claim |
| **Search** | **OpenSearch** | Free-text across inventory, grievances, breach notes, audit |
| **Identity** | **Keycloak** (or Auth0/WorkOS) | Per-tenant SSO, MFA, SCIM, RBAC |
| **Secrets** | **Vault + cloud KMS/HSM** | Per-tenant keys; BYOK for enterprise |
| **Documents** | **Playwright (headless Chromium) + HTML templates** | RoPA, consent certificates, breach notices, evidence bundles |
| **Frontend** | **Next.js + React + TypeScript**, TanStack Query, Tailwind | SSR for the public grievance portal (speed on poor networks); SPA-like for the dashboard |
| **Consent SDK** | **Vanilla TS, < 5 KB, CDN** | Must drop into any client website. Size is a feature. |
| **Runtime** | **Kubernetes** (EKS), Mumbai + Hyderabad DR | |
| **IaC / CI-CD** | Terraform + ArgoCD + GitHub Actions | Reproducible; audit-friendly change history |
| **Observability** | OpenTelemetry → Prometheus / Grafana / Loki / Tempo; Sentry | |

### 4.2 The three decisions that matter most

1. **PostgreSQL with Row-Level Security** as the isolation mechanism — not `WHERE tenant_id = ?` in application code.
2. **Temporal** for breach and grievance deadlines — not cron plus a status column. *(Cron plus a status column is how compliance platforms silently miss a statutory deadline and get their client fined.)*
3. **An introspection-only connector interface** where reading customer data is structurally impossible — not merely against policy.

### 4.3 Why the modules don't share one design

The modules have wildly different physics:

| Module | Shape | Volume | Storage pattern |
|---|---|---|---|
| **Consent** | Firehose | Millions of tiny append-only events | Event stream → columnar store |
| **Data Inventory** | Filing cabinet | Hundreds of rows, read-heavy, rarely edited | Relational, versioned |
| **Breach / Grievance / Request Tracker** | Long-lived workflows | Low volume, deadline-driven, legally consequential | Durable state machines |

A single technology optimised for all three would be mediocre at each. **One platform, three storage/processing patterns.** Note that Breach, Grievance, and the Data Principal Request Tracker share the *same* physics — deadline-bound state machines — which is exactly why they share the `WorkflowRunner` seam (S3) and, later, the same Temporal engine.

### 4.4 Multi-tenancy

| Tier | Model | Who | Mechanism |
|---|---|---|---|
| **Standard** (default) | Shared DB, shared schema, **RLS-enforced** | SMBs | Every table carries `tenant_id`. An RLS policy binds every query to a session variable set from the authenticated JWT. |
| **Premium** | Shared cluster, **schema per tenant** | Mid-market, regulated | Separate schema, separate connection pool, noisy-neighbour containment |
| **Enterprise / Sovereign** | **Dedicated database or stack** | Banks, hospital chains, government | Same code, different deployment target; per-tenant KMS; BYOK |

**Design rule: tenant tier is a deployment/routing concern, never an application-code concern.** The app resolves a tenant → a connection descriptor. Moving a client between tiers is a migration, not a rewrite.

**Tenant context propagation:** tenant ID extracted from the JWT at the edge → injected into async-local context → set as a Postgres session variable on connection checkout → carried on every event message and workflow → stamped on every log line and trace span. **There is no code path where tenant is optional.**

### 4.5 The connector framework

**The universal contract.** Every connector — regardless of source — emits only these four things:

1. Data-element candidates (table name, column name, inferred type, inferred PII category — **sample-free**)
2. Consent events
3. Breach records
4. Grievance tickets

Because the *output* is fixed, the *input* technology is irrelevant. This is §1.6, expressed as an interface.

**The database abstraction — one interface, many drivers:**

```
SchemaSource
  ├── testConnection()
  ├── listSchemas()
  ├── listTables(schema)
  ├── listColumns(table)   → { name, type, nullable, comment }
  └── listConstraints(table)

        ✗ readRows()  ←  DOES NOT EXIST IN THE INTERFACE
```

**Because `readRows()` does not exist in the contract, no connector can exfiltrate customer data. Invariant I1 is enforced by the type system, not by a code review.**

**Ingestion paths:**

| Path | Client type | Mechanism | Stage |
|---|---|---|---|
| **P1 — Manual forms** | Small business | Guided wizard, sector templates | 0 |
| **P2 — File import** | Small business | Excel/CSV → column mapping → validation. File retained in WORM storage as evidence of what was declared. | 0 |
| **P3 — SaaS connectors** | Medium | OAuth into Zoho/Shopify/Salesforce; read **object/field definitions only** | 2 |
| **P4 — Read-only DB introspection** | Larger/technical | Catalog-only credential; queries `information_schema` — never user tables | 6 |
| **P5 — On-prem agent** | Enterprise | Small Go binary inside the client's network; introspects locally; pushes metadata **outbound over TLS**. No inbound firewall rule; **no DB credential ever leaves their premises.** | 6 |

> **P5 is the enterprise unlock.** Hospitals and banks will not give an internet-facing service a database credential. An outbound-only agent turns a hard "no" into a routine security review.

**Driver waves (when you get to Stage 6):**
- Wave 1: PostgreSQL, MySQL/MariaDB, MS SQL Server, Oracle
- Wave 2: MongoDB, Snowflake, BigQuery, Redshift
- Wave 3: DynamoDB, Cassandra, Elasticsearch, Databricks, SAP HANA

*MongoDB is the interesting case — no `information_schema`. The connector infers field **names** by sampling documents and discarding values inside the driver, before they cross a process boundary. Only the key set is ever transmitted.*

**PII classification — three tiers:**
1. **Rule/dictionary** (deterministic, explainable, handles ~80%) — Indian lexicon: `aadhaar`, `pan`, `abha_id`, `upi`, `mobile`, `mrn`, `dob`
2. **Pattern/type heuristics** — column type + length + constraints
3. **ML/LLM assist** *(optional, opt-in)* — embeddings over column **names and comments only.** Never sees data values. Always produces a *suggestion*.

> Every classification is a suggestion a human must confirm. **Under DPDP, the client is the Data Fiduciary and must own the determination. The platform advises; it never decides.**

---

## PART 5 — The five seams

These are the *only* places where deferring costs you a rewrite. Build them in Stages 0–1. Everything else in Part 4 can safely wait.

| Seam | Stage 0–1 implementation | Becomes, later | Cost of retrofitting |
|---|---|---|---|
| **S1 — Tenant context** | Postgres RLS on every table, from migration #1. Tenant from JWT → session GUC. | Schema-per-tenant → dedicated DB | **Catastrophic.** Retrofitting isolation into a live multi-tenant DB means auditing every query ever written — and one miss is a breach of the exact law you sell compliance with. |
| **S2 — `EventSink` interface** | Implementation writes consent events to an append-only, partitioned Postgres table | Implementation publishes to Kafka; consumers fan out to Postgres + ClickHouse | **Severe.** If consent events are ad-hoc `INSERT`s scattered through service code, the write path cannot move without touching every call site. |
| **S3 — `WorkflowRunner` interface** | Jobs table + BullMQ worker + a deadline ticker | Temporal | **Severe.** Otherwise workflow logic metastasises into `if (status === 'X' && daysSince > 3)` conditionals across controllers, and Temporal can never be adopted without rewriting Breach and Grievance. |
| **S4 — `SchemaSource` interface** (no `readRows()`) | Only `ManualEntry` and `FileImport` implementations exist | + DB drivers, SaaS adapters, on-prem agent | **Cheap now, high value.** Defining it takes an afternoon and permanently makes I1 structurally enforceable. |
| **S5 — Audit interceptor** | Hash-chained append-only Postgres table, written by one interceptor | ClickHouse + daily Merkle roots in S3 Object Lock | **Impossible.** You cannot backfill an audit trail. |

> **The strategy in one line: build the seams now, build the systems later.**
>
> A seam is a place you can cut without bleeding. If the seam exists, swapping `PostgresEventSink` for `KafkaEventSink` is a two-day config change. If it doesn't, it's a six-month rewrite and a hiring round.

---

## PART 6 — Data model

```
Organisation (Tenant)
 ├── Users · Roles · SSO config
 ├── Designations (DPO, Grievance Officer)  ── published on public portal
 ├── Systems / Assets
 ├── Vendors / Processors                    ── third-party sharing
 ├── DataElements ──┬── PIICategory          ── SensitivityLevel
 │                  ├── ProcessingPurpose    ── LegalBasis
 │                  └── RetentionRule
 │        (every version retained; nothing overwritten)
 ├── Notices (versioned) ── NoticeTranslations (per language)
 ├── ConsentPurposes ── ConsentEvents  [append-only · bitemporal · partitioned]
 ├── Breaches ── BreachTasks · BreachNotifications · Evidence
 ├── DeadlinePolicies (versioned config — NOT code)   ← shared by Breach, Grievance & DPRequests
 ├── Grievances (complaints) ── GrievanceMessages · SLATimers
 ├── DPRequests (rights requests) ──┬── RequestType (access/correction/erasure/nomination/portability/withdraw)
 │                                  ├── SLATimer · EscalationLadder
 │                                  ├── VerificationTask (client-side identity match)
 │                                  ├── FulfilmentJobs (signed webhooks; NO raw payload persisted)
 │                                  └── PersonalDataSummary (Tier-1 metadata only; Tier-2 relayed, not stored)
 ├── Connectors ── ConnectorRuns ── SchemaSnapshots (versioned)
 └── AuditEntries  [hash-chained · immutable]
```

> The public portal, OTP verification, ticketing, SLA timers, and the verification handoff are **shared services** used by both `Grievances` and `DPRequests`. `DPRequests` is a distinct entity because it carries the rights-request lifecycle and the Personal Data Summary — but it is not a second ticketing system.

**Two modelling principles, stated explicitly:**

1. **Everything user-facing is versioned** — notices, inventory, policies, templates.
2. **Nothing is hard-deleted.** Soft-delete + tombstone + retention policy. Deletion of *platform* data is itself an audited event requiring approval.

**The consent event envelope (the most important schema in the system):**

| Field | Note |
|---|---|
| `tenant_id` | |
| `subject_ref` | **HMAC'd with a per-tenant secret.** Opaque to the platform (I2). |
| `purpose_id` | |
| `status` | `GRANTED` / `WITHDRAWN` / `EXPIRED` |
| `notice_version_id` | **Critical.** Which exact notice text the person saw. |
| `occurred_at` | Valid-time — when it happened |
| `recorded_at` | Transaction-time — when we learned about it |
| `source` | `web_sdk` / `mobile_sdk` / `api` / `portal` / `import` |
| `evidence_hash` | |
| `idempotency_key` | |

Two timestamps, not one. That is what "bitemporal" means, and it is what lets you answer *"what was true on 3rd March, as far as we knew on 3rd March?"* — which is the question a regulator actually asks.

---

## PART 7 — Stage-by-stage implementation

```
STAGE 0        STAGE 1        STAGE 2        STAGE 3        STAGE 4        STAGE 5        STAGE 6
Demo &         Working        Sell &         Split the      Split the      Real           Enterprise
pilot          product        harden         write path     read path      workflows      & sovereign
6 wks          13 wks         10 wks         7 wks          7 wks          7 wks          ongoing
2–3 eng        3 eng          4 eng          5–6 eng        6–7 eng        7–8 eng        10+ eng
₹8k/mo         ₹20k/mo        ₹60k/mo        ₹1.5L/mo       ₹3L/mo         ₹4L/mo         ₹8L+/mo
1 pilot        3–5 paying     ~50 clients    ~200           ~1,000         ~3,000         5,000–10,000+
```

---

## STAGE 0 — Demo & Pilot
### *Get in front of your client with something real*

**6 weeks · 2–3 engineers + 1 designer · ~₹8k/month infra**

### The one rule for this stage

**Do not build a throwaway prototype.** A clickable mock or a fake-data demo teaches you nothing, gets discarded, and costs you six weeks. Build the **real foundation plus one genuinely working module**, and demo *that*. **Every line you write in Stage 0 survives into production.**

### Scope

| Area | Deliverable | Requirements |
|---|---|---|
| **Foundation** | NestJS monolith · Postgres with **RLS from migration #1** · auth with MFA · RBAC skeleton · **hash-chained audit interceptor** · module boundaries defined (`identity`, `inventory`, `consent`, `breach`, `grievance`, `audit`, `notify`) | S1, S5, FR-IDN-01/02/03, FR-AUD-01/02/03 |
| **One full module** | **Data Inventory** — guided forms, Excel/CSV import with column mapping, PII classification with the Indian dictionary, human accept/reject, full versioning | FR-INV-01/02/03/04/08, S4 |
| **The killer artefact** | **RoPA export as PDF** | FR-INV-09 |
| **Dashboard** | The four-counter layout + activity feed. Three counters read zero. That is fine and honest. | FR-DSH-01 |
| **Other four modules** | Present in the nav, marked *"Coming in your pilot."* **Do not fake them with dummy data.** | — |
| **Infra** | One app container + managed Postgres on Render / Railway / ECS Fargate. **Not Kubernetes.** | — |
| **CI** | Build, test, and the **cross-tenant isolation suite** — from day one | NFR-SEC-05 |

### Week-by-week

| Week | Work |
|---|---|
| 1 | Repo, module skeleton, Postgres, **RLS policies**, migrations, CI pipeline + isolation test suite |
| 2 | Auth, MFA, tenant provisioning, RBAC skeleton, **audit interceptor with hash chain** |
| 3 | Data Inventory: entity model, guided forms, versioning |
| 4 | Excel/CSV import, column-mapping UI, validation, file retention in S3 |
| 5 | PII classification dictionary (Indian lexicon), confidence scores, human accept/reject flow |
| 6 | Dashboard shell + **RoPA PDF export** + demo polish |

### The demo script

1. **Sign up** → their own private workspace appears. *This is multi-tenancy, actually working — not a mock.*
2. **Upload their existing customer spreadsheet** → watch the platform identify `email`, `phone`, `aadhaar` as personal-data categories — **and store not one row of the actual data.** Say that sentence out loud. It is the entire product.
3. **Click one button** → out comes a regulator-ready Record of Processing Activities PDF with their company name on it.
4. **Show the audit log** → every action they just took, hash-chained and tamper-evident.

### Definition of done
- A real tenant exists with real inventory data.
- The isolation suite passes: a second tenant cannot see the first tenant's rows, even with a deliberately malformed query.
- The RoPA PDF is something a compliance officer would actually file.

### Exit criteria → Stage 1
**One signed pilot client** with a committed contact who will give weekly feedback. Their sector determines which SaaS connector you build in Stage 2. Their objections determine what you fix in Stage 1.

---

## STAGE 1 — The Working Product
### *Everything in the concept document, actually working, on boring infrastructure*

**13 weeks · 3 engineers + 1 designer + a privacy lawyer on retainer · ~₹20k/month infra**

This is the "basic software that does all the work." **All five modules are genuinely functional and sellable. Nothing is a stub.** It simply runs on one Postgres database.

### Stack

| Component | Choice |
|---|---|
| Backend | NestJS (TypeScript) — modular monolith. **Modules communicate through service interfaces only. Never reach into another module's tables.** |
| Database | PostgreSQL 16 (managed). RLS everywhere. Consent events in a partitioned append-only table. |
| Jobs & deadlines | BullMQ on Redis (or pg-boss for zero extra infra) — behind `WorkflowRunner` (S3) |
| Frontend | Next.js — one app, three surfaces: dashboard, public grievance portal, admin |
| Consent SDK | Vanilla TS, < 5 KB, CDN-delivered, with SRI hashes |
| Files & PDFs | S3 + Playwright (HTML → PDF) |
| Auth | Keycloak / Auth0 — email + MFA |
| Email / SMS | SES or Postmark; MSG91 or Gupshup for SMS/WhatsApp |
| Deploy | Two containers (app + worker). **Still not Kubernetes.** |
| Monitoring | Sentry + structured logs |

### Build order and why

**Consent is built second, not last — because it carries the most technical risk. De-risk early.**

#### Weeks 1–2 · Data Inventory completion
Add to Stage 0: retention rules, processing purposes, legal basis, systems/assets register, **third-party processor mapping** *(clients always forget this, and it's a DPDP obligation)*, data-flow visualisation, sector templates.
→ `FR-INV-05/06/07/10/11`

#### Weeks 3–7 · Consent Register
- Consent purposes per tenant · notice management with **versioning and multilingual support**
- SDK (< 5 KB) → REST ingest endpoint → validate → **pseudonymise (per-tenant HMAC)** → append via `EventSink` (S2)
- **Bitemporal append-only store.** A withdrawal is a *new event*. Never an update.
- One-click withdrawal (as easy as granting — a legal requirement)
- Signed webhook to the client on any consent change
- Proof-of-consent export
→ `FR-CON-01…09`, `S2`

> **Do not compromise on notice versioning or bitemporality here.** Both are cheap to build now and effectively impossible to retrofit — you would have to re-version every consent record you ever wrote. This is where most competing products are quietly broken.

#### Weeks 8–9 · The shared request substrate + Grievance Register
Build the substrate once; both this and the Request Tracker sit on it.
- Branded public portal per tenant · OTP contact verification
- **The identity-verification handoff** (FR-GRV-04) — platform orchestrates, client identifies
- Ticket lifecycle, SLA timers via `WorkflowRunner`, escalation ladder
- Grievance/complaint intake and resolution on top of the substrate
→ `FR-GRV-01…07`, `S3`

#### Weeks 10–11 · Data Principal Request Tracker
The centrepiece the client explicitly wants: *"tell me what personal information of mine you hold."*
- Rights-request intake on the shared portal: access, correction, erasure, nomination, portability, withdraw-consent (`FR-DPR-01/02`)
- **Statutory deadline tracking to on-time closure** — SLA clock + escalating alerts, driven by versioned deadline policies (`FR-DPR-03`)
- **Subject-reference resolution** — client supplies the raw ID during verification; platform HMACs it to find the person's records, never storing or reversing the raw ID (`FR-DPR-06`)
- **Personal Data Summary — Tier 1** — auto-assembled from Data Inventory + Consent Register + request history: which categories are held, why, where, for how long, plus full consent and request history (`FR-DPR-04`). *This is the demo moment — the platform answers "what do you have on me?" from metadata alone.*
- **Personal Data Summary — Tier 2 (manual/webhook)** — fire a signed fulfilment request; the client assembles and returns the actual values; the platform relays or links them **without persisting the raw payload** (`FR-DPR-05`)
- **Fulfilment webhooks** for correction/erasure/portability — you never edit or delete customer data; you *prove* the action was requested, actioned, and confirmed (`FR-DPR-08`)
- Request register + on-time-closure evidence export (`FR-DPR-09`)
→ `FR-DPR-01…06, 08, 09`, `S3`

#### Weeks 12–13 · Breach Register
- Incident intake (data categories drawn from the Data Inventory — the modules connect here, and it's a genuinely impressive demo moment)
- **Deadline policies as versioned config records** (the same policy engine now powers Breach and the Request Tracker)
- Guided workflow with gates · escalating alerts · notification template generation
- Evidence upload with hash recording · sealed closure packet PDF
→ `FR-BRC-01…07`, `S3`

### Deliberately NOT built in Stage 1

| Skipped | Why it's safe | Returns in |
|---|---|---|
| **Kafka** | 100k events/month = ~2 per minute. A single Postgres insert won't notice. | Stage 3 |
| **ClickHouse** | 1.2M rows/year fits comfortably in a partitioned table. | Stage 4 |
| **Temporal** | A jobs table handles a few hundred deadlines. | Stage 5 |
| **Kubernetes** | Two containers do not need an orchestrator. It is a tax you'd pay for nothing. | Stage 3 |
| **DB introspection connectors** | **§1.6 is your permission slip.** Small and medium clients type it in or upload a CSV. Building an Oracle driver before you have a customer who owns Oracle is expensive guessing. | Stage 6 |
| **On-prem agent** | Same reasoning. | Stage 6 |
| **SSO / SCIM** | Your first clients log in with a password. | Stage 2 |
| **Microservices** | You have three engineers. | Never, forcibly |

### Capacity
~50 tenants · 100k consent events/month · 50 concurrent dashboard users. Comfortable on a single small managed Postgres instance.

### Exit criteria → Stage 2
**3–5 paying clients in production**, and their feedback — not your roadmap — telling you what's missing next.

---

## STAGE 2 — Sell It and Harden It

**10 weeks · 4 engineers + a security consultant · ~₹60k/month**

**Nothing in this stage is about scale. It is about being *buyable*.** This is the stage most technical founders skip in order to go build Kafka, and it costs them a year.

| Build | Why |
|---|---|
| **SSO (SAML/OIDC) + SCIM** (`FR-IDN-06`) | The first mid-market prospect will ask. "Not yet" loses the deal. |
| **Redis caching for dashboard counters** + a **read replica** (`FR-DSH-05`) | Reports and exports move off the primary |
| **Granular RBAC** (`FR-IDN-03`) | Owner / DPO / Compliance Officer / Grievance Officer / Auditor / Viewer |
| **Your first SaaS connector** (`FR-INV-12`) | **Only the one your existing clients actually use.** If three of five run Zoho, build Zoho. Do not build Shopify because it was on a slide. |
| **Mobile SDK wrappers** (`FR-CON-10`) | |
| **Combined Personal Data Summary PDF** (`FR-DPR-07`) | Branded, regulator-ready access-request response (Tier 1 + Tier 2 confirmation) — turns the raw access workflow into a polished deliverable the client can be proud to send |
| **Compliance-health score + task list** (`FR-DSH-04`) | Drives daily engagement — the thing that stops churn |
| **Third-party penetration test + ISO 27001 readiness** (`NFR-SEC-06`, `NFR-CMP-01`) | You are selling compliance; you *will* be asked how you comply. **Start now — certification takes 6–9 months of calendar time no matter how hard you push.** |

**Trigger to Stage 3:** consent ingest p99 > 200 ms, **or** one client's traffic spike visibly slows another client's dashboard.

---

## STAGE 3 — Split the Write Path
### *The first real scaling move*

**7 weeks · 5–6 engineers (hire your first SRE) · ~₹1.5L/month**

**The problem you are now solving:** consent events hit the same database that serves dashboards. One client's marketing campaign slows everyone's UI. Worse — the SDK sits on your client's *checkout page*. If your database is under pressure, **their** site gets slow. Their outage, your fault.

**Build:**
1. **A stateless edge collector** — does exactly three things: validate, pseudonymise, publish. It **never touches a database.** Autoscales independently. It is now the only thing of yours in the critical path of your clients' websites, and it cannot be allowed to fall over.
2. **Managed Kafka** (MSK / Confluent / Redpanda), partitioned by tenant.
3. **A consumer** writing to the same Postgres table as before.
4. **Kubernetes** — you now have enough moving parts to justify it.
5. **Per-tenant rate limits and quotas** at the edge.

> **Because seam S2 exists, business logic changes by roughly zero lines.** You swap `PostgresEventSink` for `KafkaEventSink` behind the same interface. The consent module never knows it happened.

**What you gain:** one client can no longer degrade another. Plus **replay** — which is itself an audit feature you can sell.

**Trigger to Stage 4:** consent table > ~100M rows, **or** a "prove consent as of date X" query takes > 2 seconds, **or** storage cost starts to hurt.

---

## STAGE 4 — Split the Read Path

**7 weeks · 6–7 engineers · ~₹3L/month**

**Build:**
- **ClickHouse**, fed by a **second Kafka consumer**. The topic already exists, so this stage is **purely additive** — no migration, no dual-write dance, no risky cutover. *That is precisely what doing Stage 3 properly bought you.*
- **CQRS read models** — dashboard counters and consent analytics from ClickHouse/Redis; Postgres keeps current-state only (`FR-CON-11`)
- **Tiered storage** — hot 90 days → warm 1 year → cold WORM archive
- **S3 Object Lock + daily Merkle roots** of the audit chain (`FR-AUD-06`). Your audit log stops being *"trust us"* and becomes *"verify us."* **This is the moat.**
- OpenSearch, if search has started to hurt

**Trigger to Stage 5:** more than ~5 distinct deadline types, escalation ladders in play, **or** — the real trigger — **a near-miss on a statutory deadline.**

---

## STAGE 5 — Real Workflows

**7 weeks · 7–8 engineers · ~₹4L/month**

**Build:** **Temporal**, behind the `WorkflowRunner` interface from S3.

- Breach, grievance, **and Data Principal rights requests** become **durable, versioned state machines** that survive deploys, crashes, and cloud outages. A cron job and a status column do not. (`FR-BRC-08`, `FR-GRV-07`, `FR-DPR-10`)
- **Deadline policies as versioned configuration.** When the Rules change, you edit a policy record. **In-flight workflows continue under the version they started with; new ones pick up the new one.** (`FR-BRC-09`) This is the property that keeps the product alive across a decade of regulatory amendment — and it matters as much for the access-request clock as for the breach clock.
- **Migration approach:** run Temporal for *new* incidents and requests only; let the old job-table workflows drain naturally. These are low-volume and short-lived, so there is no big-bang cutover to fear.

**Trigger to Stage 6:** an enterprise deal on the table that requires DB introspection or on-prem deployment.

---

## STAGE 6 — Enterprise & Sovereign

**Ongoing · 10+ engineers · ₹8L+/month**

Build in the order your **deals** demand — not the order the diagram suggests.

| Build | Note |
|---|---|
| **DB introspection connectors** (`FR-INV-13`) | Wave 1 (Postgres, MySQL, MSSQL, Oracle) behind the existing `SchemaSource` interface. **Note this arrives in year two — which is correct. By now you *know* which databases your customers own, instead of guessing.** |
| **On-prem Go agent** (`FR-INV-14`) | Outbound-only. No hospital or bank has to open a firewall or hand you a credential. **Converts an enterprise security review from a hard "no" into a routine one.** |
| **Automated access-request fulfilment** (`FR-DPR-11`) | Once a SaaS connector or the agent exists, extend it (in a scoped, audited *fulfilment mode*) to help assemble the **Tier-2** personal-data package directly from the client's systems — still relayed, never persisted. Turns the access-request response from a manual chore into one click for the client's officer. |
| **Schema-per-tenant + dedicated-DB tiers** (`FR-IDN-07`) | Same codebase, different connection descriptor |
| **BYOK / HYOK**, per-tenant KMS keys | `NFR-SEC-02` |
| **Tenant→shard directory service** | Design it as a single-row lookup in Stage 1; *activate* it here |
| **Multi-region** active-passive: Mumbai + Hyderabad | RPO ≤ 5 min, RTO ≤ 1 hr, **drilled quarterly and shown to enterprise buyers as a sales asset** |
| **ISO 27001 certified · SOC 2 Type II underway** | |

---

## PART 8 — The rules that keep this honest

| # | Rule | Why |
|---|---|---|
| **R1** | **Never cross a stage boundary without a trigger metric.** | "The architecture feels incomplete" is not a trigger. A p99 latency number is. **Premature Kafka has killed more startups than missing Kafka ever has.** |
| **R2** | **Never let a module reach into another module's tables.** | Service interfaces only. Costs nothing today; is the entire reason a service split is possible later. |
| **R3** | **Never write an ad-hoc INSERT** into consent, audit, or workflow tables. | Everything goes through the sink / runner / interceptor. **One exception, once, and the seam is gone.** |
| **R4** | **Never build a connector before a paying customer names that specific database.** | |
| **R5** | **Never skip the cross-tenant isolation suite** — even in Stage 0. | It is a few hundred lines of test code protecting the only promise you actually sell. |
| **R6** | **Never PERSIST customer data "just temporarily."** | There is no such thing as temporary durable storage. The moment one row of patient data lands in your database (or a temp table, cache, file, or log), the product's premise — and its legal position — is dead. This governs *persistence*: a Mode-B raw value held in memory for one authorized operation and never written down is transit, not storage (see I1 / §2.1). |

---

## PART 9 — Parallel tracks

| Track | Stage 0–1 | Stage 2–3 | Stage 4–6 |
|---|---|---|---|
| **Legal** | Privacy lawyer on retainer reviews the consent model, notice templates, and **deadline policy values against the Rules currently in force** | Counsel signs off on breach notification templates and the regulator report format | Standing counsel; policies updated within days of any amendment |
| **Security** | Isolation suite in CI; secrets in a vault, never env vars | Pen test; ISO 27001 readiness | ISO certified; SOC 2 Type II; bug bounty |
| **Your own DPDP position** | **Recognise it explicitly: you are a Data Processor.** Draft your DPA. | Publish sub-processor list + security whitepaper | Annual audits; customer-facing trust portal |
| **Sales** | 1 pilot | 3–5 paying → ~50 | Mid-market → enterprise |

> **On being a Data Processor:** pseudonymised subject references, IP addresses, and grievance correspondence **are personal data**. You must be exemplary, or you cannot credibly sell compliance. The good news is that the architecture is itself the mitigation — if you are breached, the blast radius is metadata, not patient records.
>
> **A note on legal timelines:** this document deliberately hardcodes **no statutory deadline values**, and neither should the software (see `FR-BRC-02`). The DPDP Act and its Rules have a phased implementation and are subject to amendment. Every deadline must be a versioned configuration record, validated by counsel against the Rules as currently in force at the time you build.

---

## PART 10 — Risks and how the design mitigates them

| Risk | Mitigation, already in the plan |
|---|---|
| A connector accidentally reads customer rows → the entire value proposition collapses | **`readRows()` does not exist in the `SchemaSource` interface.** Enforced by types, tested in CI, verified in pen tests. |
| Cross-tenant data leak | **RLS in the database engine** + an automated cross-tenant attack suite on every PR |
| A missed statutory deadline caused by a platform bug → client is fined → platform is sued | Durable workflows (Temporal), redundant alerting, deadline policies as versioned config |
| The DPDP Rules change | Deadlines, notice templates, purposes, and legal bases are all **data, not code** |
| Client's DB is behind a firewall / IT refuses credentials | **The on-prem outbound-only agent** (P5) |
| One tenant's consent volume degrades everyone | Edge collectors + Kafka + per-tenant rate limits and partitions |
| **The platform itself is breached** | Per-tenant keys, field-level encryption, and **minimal data by design.** The blast radius is metadata, not patient records. **The architecture is the mitigation.** |
| An access request tempts you to store the person's actual data "to make the summary complete" → I1 is broken and the whole premise dies | The **two-tier summary** (`FR-DPR-04/05`): Tier 1 is metadata the platform owns; Tier 2 is relayed-and-forgotten, never persisted. The summary is complete *without* the platform becoming a copy-of-record. |
| Building the wrong thing for a year | Stage 0 puts a real product in front of a real client in **6 weeks** |

---

## PART 11 — Glossary

| Term | Meaning |
|---|---|
| **Data Fiduciary** | The client company — decides why and how personal data is processed. Legally accountable. |
| **Data Principal** | The individual whose data it is (the client's customer/patient). |
| **Data Processor** | Processes data on the Fiduciary's behalf. **This is what the platform is.** |
| **RoPA** | Record of Processing Activities — the master compliance document, auto-generated from the Data Inventory. |
| **Data Principal request** | A formal request a person makes to exercise a right over their own data — access, correction, erasure, nomination, portability, or consent withdrawal (DPDP Act, Sections 11–14). Handled by the Data Principal Request Tracker. |
| **Right to access** | The Data Principal's right (Section 11) to be told what personal information of theirs a fiduciary holds and is using — the request the Request Tracker exists to fulfil. |
| **Personal Data Summary** | The response to an access request. **Tier 1** = the map of the person's data (categories, purposes, locations, retention, consent and request history) the platform assembles from its own metadata. **Tier 2** = the actual data values, assembled by the client and relayed by the platform without being stored. |
| **Bitemporal** | Storing both *when something happened* and *when we learned about it* — so historical states can be reconstructed exactly. |
| **RLS** | Row-Level Security — Postgres enforcing tenant isolation at the engine level. |
| **WORM** | Write Once, Read Many — immutable storage that makes tamper-evidence provable. |
| **Seam** | A place in the code you can cut without bleeding — an interface with a simple implementation today and a big system behind it tomorrow. |

---

## PART 12 — The whole thing, in one paragraph

Build a **NestJS modular monolith on a single PostgreSQL database**, and put five seams into it from the first migration: **RLS-enforced tenancy, an `EventSink` interface for consent, a `WorkflowRunner` interface for deadlines, an introspection-only `SchemaSource` with no `readRows()`, and a hash-chained audit log.** Ship Data Inventory and the RoPA PDF export in six weeks, demo it, and sign a pilot. Ship the other four modules — Consent, Grievance, the **Data Principal Request Tracker** (with its two-tier Personal Data Summary that answers *"what do you hold on me?"* from metadata alone), and Breach — in thirteen more weeks and start selling. Then — **and only when a trigger metric forces you** — slide **Kafka** in behind the event sink, **ClickHouse** in behind it as a second consumer, and **Temporal** in behind the workflow runner, each one an additive change touching roughly zero lines of business logic. Build database connectors **last**, in year two, once your customers have told you which databases they actually own. The monolith never dies; it simply sheds the two things that never belonged in it. **There is no rewrite anywhere on this path — and that is the entire point.**
