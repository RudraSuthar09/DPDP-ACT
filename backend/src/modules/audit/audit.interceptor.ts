import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { defaultIfEmpty, firstValueFrom, from, type Observable } from 'rxjs';
import type { AuditOutcome, AuditSink, AuditWrite } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { UnitOfWorkService } from '../../database/unit-of-work';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService, type AuditAnnotation } from './audit-context.service';
import { AUDITED_KEY, NO_AUDIT_KEY } from './audited.decorator';
import { AUDIT_SINK } from './postgres-audit.sink';

/** Methods that change nothing, and so have nothing to be evidence of. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Seam S5 — THE audit interceptor. Not "an" interceptor: the one and only writer
 * of the audit log (R3). Registered globally, so it covers routes that do not
 * know it exists.
 *
 * ---------------------------------------------------------------------------
 * HOW A MUTATION FLOWS THROUGH HERE
 *
 *   POST /users/:id/status  { status: 'suspended', reason: 'left the company' }
 *
 *   1. TenantContextMiddleware verifies the JWT and puts tenant/user/correlation
 *      id into AsyncLocalStorage (Seam S1).
 *   2. RolesGuard checks the role.
 *   3. THIS interceptor opens the request's unit of work — one transaction —
 *      and an empty audit annotation, then calls the handler.
 *   4. IdentityService.changeStatus reads the user (the BEFORE state), updates
 *      it (the AFTER state), and calls auditContext.annotate({...}) with both,
 *      plus the reason and the target. It never touches the audit log.
 *   5. The handler returns. This interceptor assembles ONE entry from what it
 *      knows (who, when, from where, correlation id, outcome) plus what the
 *      service annotated (what, to whom, why, before, after), and appends it
 *      through the sink — on the SAME transaction the update ran in.
 *   6. Commit. The status change and the evidence of it become true together.
 *      If the append had failed, the suspension would have rolled back with it:
 *      there is no path that produces a change without its entry (I4).
 *
 * A trigger then computes seq/prev_hash/hash from the head of that tenant's
 * chain, so the entry is linked to every entry before it before it ever lands.
 * ---------------------------------------------------------------------------
 *
 * FAILURES are audited too — "who tried" is often the more interesting question.
 * They are recorded in a SEPARATE transaction, after the business transaction
 * has rolled back, because a failed action changed nothing and so has nothing to
 * be atomic with. If we appended it to the doomed transaction, the rollback
 * would erase the record of the attempt.
 *
 * KNOWN GAP: a denial from RolesGuard is not recorded, because guards run before
 * interceptors in Nest — the handler, and therefore this code, is never reached.
 * Auditing those would need a second writer (an exception filter), which R3
 * forbids, so it stays a gap rather than becoming a crack in the rule. Failures
 * raised INSIDE handlers and services (the last-Owner refusal, a bad MFA code)
 * do flow through here and are recorded as outcome='denied'.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditContext: AuditContextService,
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
    private readonly uow: UnitOfWorkService,
    @Inject(AUDIT_SINK) private readonly sink: AuditSink,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.shouldAudit(context)) {
      return next.handle();
    }
    return from(this.runAudited(context, next));
  }

  private async runAudited(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const action = this.actionName(context);

    // The unit of work goes OUTSIDE the annotation scope and wraps the handler:
    // every withTenant() the handler makes joins this one transaction, and the
    // audit append below lands in it too. Without this, each call would open and
    // commit its own transaction and the entry could not be atomic with the
    // change — see unit-of-work.ts for why that matters.
    return this.uow.run(async () =>
      this.auditContext.run(async (annotation) => {
        try {
          // Subscribing here — inside the ALS scopes — is what puts the handler,
          // its database calls, and its annotations in the same context.
          const result = await firstValueFrom(next.handle().pipe(defaultIfEmpty(undefined)));

          await this.append(action, 'success', request, annotation);
          // Only now. The entry is in the transaction; this makes both real.
          await this.db.commitUnitOfWork();
          return result;
        } catch (err) {
          // The change is gone. The attempt is not.
          await this.db.rollbackUnitOfWork().catch((rollbackErr) => {
            this.logger.error(`Rollback failed for ${action}: ${String(rollbackErr)}`);
          });
          await this.appendFailure(action, request, annotation, err);
          throw err;
        }
      }),
    );
  }

  private shouldAudit(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return false;
    }
    if (
      this.reflector.getAllAndOverride<boolean>(NO_AUDIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return false;
    }
    const request = context.switchToHttp().getRequest<Request>();
    // Stage 1 audits state changes. Reads are not yet recorded: at this volume
    // it would be noise, and nothing here exposes customer records to read (I1).
    // When the Personal Data Summary lands (FR-DPR), reads of it will need
    // recording, and this is the line that changes.
    return !SAFE_METHODS.has(request.method.toUpperCase());
  }

  /**
   * The action name: the @Audited name if the route named itself, otherwise a
   * derived one. Deriving means a new route is audited under a mediocre name
   * rather than not audited at all — the same default-on reasoning as the RBAC
   * read-only floor.
   */
  private actionName(context: ExecutionContext): string {
    const declared = this.reflector.getAllAndOverride<string>(AUDITED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return declared ?? `unnamed.${context.getClass().name}.${context.getHandler().name}`;
  }

  private async append(
    action: string,
    outcome: AuditOutcome,
    request: Request,
    annotation: AuditAnnotation,
  ): Promise<void> {
    const ctx = this.tenantContext.get();
    const write: AuditWrite = {
      action: annotation.action ?? action,
      outcome,
      correlationId: ctx?.correlationId ?? this.correlationIdFrom(request),
      // The service may name the actor when the request could not (registration
      // creates the very user who is acting).
      actorId: annotation.actorId ?? ctx?.userId ?? null,
      actorLabel: annotation.actorLabel ?? null,
      targetType: annotation.targetType ?? null,
      targetId: annotation.targetId ?? null,
      reason: annotation.reason ?? null,
      beforeState: annotation.beforeState ?? null,
      afterState: annotation.afterState ?? null,
      sourceIp: this.sourceIp(request),
      userAgent: request.get('user-agent') ?? null,
    };
    await this.sink.record(write);
  }

  /**
   * Record a refused or failed attempt, in its own transaction.
   *
   * Deliberately best-effort: if we cannot record the failure we log loudly and
   * still surface the ORIGINAL error to the caller. Masking a 403 with a 500
   * from the audit path would tell the user the wrong thing about their request
   * and lose the real error. A successful change is never best-effort — that
   * path is atomic, above.
   */
  private async appendFailure(
    action: string,
    request: Request,
    annotation: AuditAnnotation,
    err: unknown,
  ): Promise<void> {
    const status = (err as { status?: number })?.status;
    // A 4xx is a decision the platform made about a request; a 5xx is the
    // platform breaking. Both are evidence, but they are not the same evidence.
    const outcome: AuditOutcome =
      typeof status === 'number' && status >= 400 && status < 500 ? 'denied' : 'error';

    // Requests with no tenant have nowhere to go: the chain is per tenant, and a
    // failed login for an unknown email belongs to no tenant. That is a real gap
    // — it wants a platform-level security log, which is not a per-tenant audit
    // chain and is not this. Recorded here as a debug line rather than pretended.
    if (!this.tenantContext.get()?.tenantId && !this.db.unitOfWorkTenantId()) {
      this.logger.debug(`Not recording ${action} (${outcome}): no tenant in scope.`);
      return;
    }

    try {
      await this.auditContext.run(async () => {
        await this.append(
          action,
          outcome,
          request,
          // Keep what the service told us, but never a before/after for a change
          // that did not happen.
          {
            ...annotation,
            beforeState: null,
            afterState: null,
            reason: annotation.reason ?? messageOf(err),
          },
        );
        await this.db.commitUnitOfWork();
      });
    } catch (auditErr) {
      this.logger.error(
        `FAILED TO RECORD an audit entry for ${action} (${outcome}): ${String(auditErr)}`,
      );
    }
  }

  private sourceIp(request: Request): string | null {
    // `ip` already honours trust proxy when it is configured; the raw socket is
    // the fallback so a direct-connect deployment still records provenance.
    return request.ip ?? request.socket?.remoteAddress ?? null;
  }

  private correlationIdFrom(request: Request): string {
    // Unauthenticated routes (register, login) have no ALS context to carry one.
    return request.header('x-correlation-id') ?? randomUUID();
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
