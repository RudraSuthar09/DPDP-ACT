/**
 * The five seams as type contracts (Part 5 of the master doc). These are
 * interfaces only — a simple Postgres-backed implementation lives in the API
 * today; a big system slides in behind each one later, touching ~zero business
 * logic. Define them now; build the systems later.
 */
import type { ConsentEventEnvelope } from './consent';
import type { WorkflowStatus } from './domain';

/**
 * S2 — EventSink. All consent events are written through this (never an ad-hoc
 * INSERT, R3). Stage 1: append-only partitioned Postgres table.
 * Later: Kafka → Postgres + ClickHouse.
 */
export interface EventSink {
  append(event: ConsentEventEnvelope): Promise<void>;
}

/** A durable job scheduled through the WorkflowRunner. */
export interface WorkflowJob {
  workflowId: string;
  /** e.g. 'breach', 'grievance', 'dprequest'. */
  kind: string;
  runAt: string;
  status: WorkflowStatus;
  payload: Record<string, unknown>;
}

/**
 * S3 — WorkflowRunner. Deadlines/SLAs for Breach, Grievance, and DPRequest run
 * through this. Stage 1: jobs table + BullMQ worker + deadline ticker.
 * Later: Temporal. Workflow logic must never metastasise into controllers.
 */
export interface WorkflowRunner {
  schedule(job: Omit<WorkflowJob, 'status'>): Promise<void>;
  cancel(workflowId: string): Promise<void>;
}

/** A discovered column definition — SAMPLE-FREE. Names and types only. */
export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
}

/**
 * S4 — SchemaSource. The connector contract that makes I1 enforceable by the
 * type system: there is NO `readRows()`, so no connector can ever read a
 * customer row. Stage 1 implementations: ManualEntry, FileImport only.
 * Later: DB drivers, SaaS adapters, on-prem agent.
 */
export interface SchemaSource {
  testConnection(): Promise<boolean>;
  listSchemas(): Promise<string[]>;
  listTables(schema: string): Promise<string[]>;
  listColumns(table: string): Promise<SchemaColumn[]>;
  // ✗ readRows() — DOES NOT EXIST IN THIS INTERFACE, BY DESIGN (I1).
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
 * S5 — Audit sink. Written by ONE interceptor, never by individual services
 * (R3). Stage 1: hash-chained append-only Postgres table.
 * Later: ClickHouse + daily Merkle roots in S3 Object Lock.
 *
 * This interface is intentionally not exported from the audit module's Nest
 * providers: no feature module can inject it, so "services never write audit
 * rows" is enforced by the injector, not by reviewer memory.
 */
export interface AuditSink {
  record(entry: AuditWrite): Promise<AuditReceipt>;
}

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
