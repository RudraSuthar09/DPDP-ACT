/**
 * The five seams as type contracts (Part 5 of the master doc). These are
 * interfaces only — a simple Postgres-backed implementation lives in the API
 * today; a big system slides in behind each one later, touching ~zero business
 * logic. Define them now; build the systems later.
 */
import type { ConsentEventEnvelope } from './consent';

// ===========================================================================
// S2 — EventSink
// ===========================================================================

/**
 * What the sink hands back once an event has been durably appended — or found to
 * already exist. Idempotency is a property of the SEAM, not of every caller
 * remembering to check first: replay the same event and you get the same receipt
 * with `deduplicated: true` and nothing new written.
 */
export interface ConsentReceipt {
  /** The platform's id for the stored event (the existing one, on a duplicate). */
  eventId: string;
  /** Transaction-time the event was FIRST recorded — the second bitemporal clock. */
  recordedAt: string;
  /** True when this idempotency key was already present: no new row was written. */
  deduplicated: boolean;
}

/**
 * S2 — EventSink. THE one write path for consent events; never an ad-hoc INSERT
 * scattered through service code (R3). Stage 1: an append-only, partitioned
 * Postgres table written only via `app.consent_append`. Later: publishes to
 * Kafka, consumers fan out to Postgres + ClickHouse — and nothing above this
 * interface changes. Swapping the implementation is a config change, not a
 * rewrite; that is the whole point of the seam.
 */
export interface EventSink {
  append(event: ConsentEventEnvelope): Promise<ConsentReceipt>;
}

// ===========================================================================
// S3 — WorkflowRunner
// ===========================================================================

/**
 * The three workflows that share the deadline substrate. They have the SAME
 * physics — a deadline-bound, must-not-be-lost state machine — which is exactly
 * why one runner (and, later, one Temporal deployment) serves all three.
 */
export const WORKFLOW_KINDS = ['breach', 'grievance', 'dprequest', 'retention'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

/**
 * The lifecycle of a scheduled deadline JOB — distinct from the ticket's own
 * `WorkflowStatus` (open/verifying/…): a job is scheduled, then it either fires,
 * is cancelled before it fires, or fails. Mirrored by the CHECK on workflow_jobs.
 */
export const WORKFLOW_JOB_STATUSES = ['scheduled', 'fired', 'cancelled', 'failed'] as const;
export type WorkflowJobStatus = (typeof WORKFLOW_JOB_STATUSES)[number];

/** A durable, tenant-scoped job scheduled through the WorkflowRunner. */
export interface WorkflowJob {
  /** Caller-owned id — usually the incident/ticket/request id. Cancel by this. */
  workflowId: string;
  kind: WorkflowKind;
  /** When the deadline fires (ISO-8601). A value the caller computed — never an
   *  `if (daysSince > 3)` that has leaked into a controller. */
  runAt: string;
  status: WorkflowJobStatus;
  /** Opaque to the runner; handed back to the handler when the job fires. Carries
   *  ids and metadata only — NEVER a customer record (I1). */
  payload: Record<string, unknown>;
}

/**
 * S3 — WorkflowRunner. Breach, Grievance, and DPRequest deadlines/SLAs all run
 * through this ONE interface. Stage 1: a jobs table + a pg-boss worker (Postgres-
 * native, no Redis) + a deadline ticker. Later: Temporal, behind this same
 * interface — Breach and Grievance never learn it changed.
 *
 * The rule this exists to keep: deadline logic lives here and in the worker,
 * never as `if (status === 'X' && daysSince > 3)` in a controller (R2/R3). A
 * controller's only move is `runner.schedule(...)`.
 */
export interface WorkflowRunner {
  /** Durably schedule a deadline. Idempotent on (workflowId, kind). */
  schedule(job: Omit<WorkflowJob, 'status'>): Promise<void>;
  /** Cancel a scheduled deadline — e.g. the incident closed before it fired. */
  cancel(workflowId: string): Promise<void>;
}

// ===========================================================================
// S4 — SchemaSource
// ===========================================================================

/**
 * How a SchemaSource was obtained. Stage 1 has exactly two; DB introspection
 * drivers, SaaS adapters and the on-prem agent are later kinds behind this SAME
 * interface — each still unable to read a row, because the method does not exist.
 */
export const SCHEMA_SOURCE_KINDS = ['manual', 'file_import'] as const;
export type SchemaSourceKind = (typeof SCHEMA_SOURCE_KINDS)[number];

/** A discovered column — SAMPLE-FREE. Names, types, nullability, comments only. */
export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
}

/** A discovered constraint — metadata about structure, never a value from a row. */
export interface SchemaConstraint {
  name: string;
  kind: 'primary_key' | 'unique' | 'foreign_key' | 'check' | 'not_null';
  columns: string[];
}

/**
 * S4 — SchemaSource. The connector contract that makes invariant I1 enforceable
 * by the TYPE SYSTEM: there is no `readRows()` — and there never will be — so no
 * connector, present or future, can read a customer row. Every method returns
 * schema metadata (names, types, structure); none returns data.
 *
 * Stage 1 implementations: ManualEntry and FileImport ONLY.
 * Later: DB introspection drivers, SaaS adapters, the on-prem agent.
 *
 *   ✗ readRows()  —  DOES NOT EXIST IN THIS INTERFACE, BY DESIGN (I1).
 *
 * Its absence is checked, not merely intended: schema-source.spec.ts fails the
 * build if any implementation grows a `readRows` (or any row-reading method).
 */
export interface SchemaSource {
  /** The kind of source — stamped as provenance on everything it discovers. */
  readonly kind: SchemaSourceKind;
  testConnection(): Promise<boolean>;
  listSchemas(): Promise<string[]>;
  listTables(schema: string): Promise<string[]>;
  listColumns(table: string): Promise<SchemaColumn[]>;
  listConstraints(table: string): Promise<SchemaConstraint[]>;
  // ✗ readRows() — intentionally absent. I1 is a fact about this type.
}

/** Whether the audited action was carried out, refused, or blew up. A refusal is
 *  evidence too: "who tried" is often the more interesting question. */
export type AuditOutcome = 'success' | 'denied' | 'error';

/**
 * What the interceptor asks to have recorded (FR-AUD-01/02, I4).
 *
 * Note the three things this type deliberately CANNOT express, because each is
 * something a caller must not get to choose:
 *   - `tenantId` — taken from the Postgres session (`app.current_tenant()`), so
 *     nothing can append to another tenant's chain even deliberately.
 *   - `occurredAt` — set by the database. An actor does not get to say when.
 *   - `seq`/`prevHash`/`hash` — computed by a trigger from the current head of
 *     the chain, so the application cannot forge a link.
 */
export interface AuditWrite {
  /** WHAT: a stable dotted name, e.g. 'identity.user.suspended'. */
  action: string;
  outcome: AuditOutcome;
  correlationId: string;
  /** WHO. Null only when there is no user row to point at (a failed login). */
  actorId?: string | null;
  /** WHO, when actorId cannot exist — e.g. the email a failed login attempted. */
  actorLabel?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  /** WHY (I4). Required at the API boundary for decisions about people. */
  reason?: string | null;
  /** Redacted by the writer: never credentials (FR-IDN-02), never customer records (I1). */
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  /** FROM WHERE. An IP is personal data; it is evidence, and treated as both. */
  sourceIp?: string | null;
  userAgent?: string | null;
}

/** A stored, chained entry as read back from the log. */
export interface AuditEntry extends AuditWrite {
  id: string;
  tenantId: string;
  /** Position in this tenant's chain, from 1. A gap means entries were removed. */
  seq: number;
  occurredAt: string;
  /** Hash of the previous entry — any tampering breaks the chain. */
  prevHash: string;
  hash: string;
}

/** Proof of append: what the sink hands back once the chain has accepted an entry. */
export interface AuditReceipt {
  id: string;
  seq: number;
  occurredAt: string;
  hash: string;
}

/**
 * S5 — Audit sink. Written by ONE interceptor for HTTP mutations, plus exactly
 * one other sanctioned caller for entries with no HTTP request behind them at
 * all (a deadline firing in the worker) — never by an ordinary feature service
 * (R3). Stage 1: hash-chained append-only Postgres table.
 * Later: ClickHouse + daily Merkle roots in S3 Object Lock.
 *
 * This interface is intentionally not exported from the audit module's Nest
 * providers: no feature module can inject it, so "services never write audit
 * rows" is enforced by the injector, not by reviewer memory. The one exception
 * — a worker-safe wrapper narrow enough to remain a single sanctioned caller,
 * not a second writer — is exported under its own name; see the audit module.
 */
export interface AuditSink {
  record(entry: AuditWrite): Promise<AuditReceipt>;
}

/**
 * Actor labels for audit entries appended from the WORKER process, where a
 * fired deadline has no HTTP request and therefore no logged-in actor to point
 * at. Same shape as `ANONYMOUS_PORTAL_ACTOR_LABEL` and `consent_sdk:<keyId>`: a
 * label where a user id would be, naming WHAT acted rather than who.
 *
 * Split by which deadline substrate fired, not just "system:worker", so a
 * reviewer scanning the log can tell a request-substrate escalation (Grievance/
 * DPRequest, FR-GRV-05) from a Breach Register gate alert (FR-BRC-04) without
 * opening the entry.
 */
export const SYSTEM_WORKER_ESCALATION_ACTOR_LABEL = 'system:worker:escalation';
export const SYSTEM_WORKER_BREACH_DEADLINE_ACTOR_LABEL = 'system:worker:breach_deadline';

/** One problem found while walking a chain. No breaks = the log is intact. */
export interface AuditChainBreak {
  seq: number;
  entryId: string;
  problem: string;
}

export interface AuditChainReport {
  intact: boolean;
  entriesChecked: number;
  headHash: string | null;
  breaks: AuditChainBreak[];
}
