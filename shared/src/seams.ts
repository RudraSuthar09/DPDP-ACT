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

/** A single hash-chained audit entry (FR-AUD-01/02). */
export interface AuditEntry {
  tenantId: string;
  actorId: string;
  action: string;
  occurredAt: string;
  correlationId: string;
  reason?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  /** Hash of the previous entry — any tampering breaks the chain. */
  prevHash: string;
  hash: string;
}

/**
 * S5 — Audit sink. Written by ONE interceptor, never by individual services
 * (R3). Stage 1: hash-chained append-only Postgres table.
 * Later: ClickHouse + daily Merkle roots in S3 Object Lock.
 */
export interface AuditSink {
  record(entry: Omit<AuditEntry, 'prevHash' | 'hash'>): Promise<AuditEntry>;
}
