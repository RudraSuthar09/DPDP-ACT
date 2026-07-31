import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditContextService } from './audit-context.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditVerifierService } from './audit-verifier.service';
import { AUDIT_SINK, PostgresAuditSink } from './postgres-audit.sink';
import { SystemAuditService } from './system-audit.service';

/**
 * Audit & Evidence — Seam S5. The hash-chained, append-only audit log, written
 * by ONE interceptor for HTTP mutations and one narrow, sanctioned second
 * caller for entries fired with no HTTP request at all — never by an ordinary
 * feature service (R3). Every entry records who/what/when/where/why +
 * before/after + tenant + correlation id, and carries the previous entry's
 * hash, so any tampering breaks the chain. It cannot be backfilled, so it
 * exists before any module writes data.
 *
 * Requirements: FR-AUD-01/02/03.  Seams: S5.  Invariants: I4.
 *
 * @Global, and imported into the WORKER process's root module too (like
 * WorkflowModule) — nothing in this module's own dependency graph reaches
 * IdentityModule or anything else that would boot-crash the worker, so unlike
 * RequestModule/BreachModule it needs no separate "worker-safe half".
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
 * What IS exported is `AuditContextService` (annotate an HTTP-mutation entry;
 * no database access at all), `AuditVerifierService` (read-only: list +
 * verifyChain), and now `SystemAuditService` — the one addition, and worth
 * being explicit about why it does not weaken the control above.
 * `SystemAuditService` cannot append arbitrary data to an arbitrary chain: its
 * only method takes a `PoolClient` the caller must already hold (nothing but a
 * `DeadlineHandler` legitimately does) and proves that client is bound to the
 * tenant the caller claims before it will touch anything. It is a second
 * SANCTIONED CALLER of the one sink, not a second writer — see its own header
 * for the full argument, and `audit-write-path.spec.ts` for what still holds:
 * every file that names `app.audit_append` still lives in this directory.
 *
 * Adding AUDIT_SINK itself to this list would quietly delete R3. Don't.
 * ---------------------------------------------------------------------------
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditContextService,
    AuditVerifierService,
    SystemAuditService,
    { provide: AUDIT_SINK, useClass: PostgresAuditSink },
    // THE interceptor. Global, so it covers handlers whose authors never read
    // this file — a route added next year is audited by default, and has to opt
    // out loudly (@NoAudit) to escape. Instantiated harmlessly in the worker
    // process too (createApplicationContext has no HTTP adapter to bind it to).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditContextService, AuditVerifierService, SystemAuditService],
})
export class AuditModule {}
