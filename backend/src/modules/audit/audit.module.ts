import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditContextService } from './audit-context.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditVerifierService } from './audit-verifier.service';
import { AUDIT_SINK, PostgresAuditSink } from './postgres-audit.sink';

/**
 * Audit & Evidence — Seam S5. The hash-chained, append-only audit log, written
 * by ONE interceptor and never by individual services (R3). Every entry records
 * who/what/when/where/why + before/after + tenant + correlation id, and carries
 * the previous entry's hash, so any tampering breaks the chain. It cannot be
 * backfilled, so it exists before any module writes data.
 *
 * Requirements: FR-AUD-01/02/03.  Seams: S5.  Invariants: I4.
 *
 * ---------------------------------------------------------------------------
 * READ THE `exports` BELOW — THAT LIST IS A SECURITY CONTROL.
 *
 * `AUDIT_SINK` is provided here and deliberately NOT exported. It is the only
 * thing that can append to the log, and because Nest resolves providers through
 * module boundaries, a service in another module that tries to inject it does
 * not get a warning or a lint error — the application fails to boot with an
 * unresolved dependency. "Services never write audit rows" is therefore enforced
 * by the injector rather than by anyone remembering.
 *
 * What IS exported is `AuditContextService`, which lets a service ANNOTATE its
 * entry (what changed, to whom, why) and has no database access whatsoever.
 * Annotating cannot become writing.
 *
 * Adding AUDIT_SINK to this list would quietly delete R3. Don't.
 * ---------------------------------------------------------------------------
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditContextService,
    AuditVerifierService,
    { provide: AUDIT_SINK, useClass: PostgresAuditSink },
    // THE interceptor. Global, so it covers handlers whose authors never read
    // this file — a route added next year is audited by default, and has to opt
    // out loudly (@NoAudit) to escape.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  // AuditContextService (annotate-only, no DB access) and AuditVerifierService
  // (READ-only: list + verifyChain) are both safe to export — neither can write
  // a row. AUDIT_SINK is the one thing that must never appear here.
  exports: [AuditContextService, AuditVerifierService],
})
export class AuditModule {}
