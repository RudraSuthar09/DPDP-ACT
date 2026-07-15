import { Module } from '@nestjs/common';

/**
 * Audit & Evidence. The hash-chained, append-only audit log (Seam S5), written
 * by ONE interceptor — never by individual services (R3). Every entry records
 * who/what/when/where/why + before/after state + tenant + correlation ID, and
 * carries the previous entry's hash so any tampering breaks the chain. Cannot be
 * backfilled, so it exists from day one.
 *
 * Requirements: FR-AUD-01..05.  Seams: S5.  Invariants: I4.
 * Skeleton only — no interceptor or providers yet.
 */
@Module({})
export class AuditModule {}
