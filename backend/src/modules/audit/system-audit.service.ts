import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditReceipt, AuditWrite } from '@dpdp/shared';
import { AUDIT_SINK, PostgresAuditSink } from './postgres-audit.sink';

/**
 * THE SANCTIONED NON-INTERCEPTOR CALLER of the audit sink — for entries with
 * no USABLE ambient tenant context for the global AuditInterceptor to record
 * against, whether because there is no HTTP request at all (a worker-fired
 * deadline) or because the request's own bearer token deliberately carries no
 * tenant (the platform-admin tool — see below).
 *
 * ===========================================================================
 * WHY THIS EXISTS
 *
 * The request substrate's escalation ladder (FR-GRV-05) and the Breach
 * Register's per-gate alerts (FR-BRC-04) both fire from the WORKER process,
 * when a scheduled deadline comes due. A worker firing has no HTTP request, so
 * the ordinary path — `AuditContextService.annotate()` inside a handler, the
 * `AuditInterceptor` assembling and appending the entry once the handler
 * returns — does not exist there. `RequestEscalationService` and
 * `BreachEscalationService` both name this gap in their own headers: the
 * escalation lands in `request_escalations` / `breach_escalations` (RLS,
 * append-only), but not in the S5 hash chain.
 *
 * That gap started as one module's documented limitation. It is now two, which
 * changes its character from "a quirk of this feature" to "a missing capability
 * every worker-fired module will hit next" — Breach's own escalation service
 * said as much. This class is that capability.
 *
 * A third, differently-shaped case hits the identical gap:
 * `LicensingService.issueForPlatformAdmin` (the cross-tenant /admin/licenses
 * support tool). That request DOES have an HTTP context, but its bearer token
 * is `typ='platform_admin'` — deliberately carrying no `tenant_id`, because
 * the whole point of the tool is to act on a tenant chosen per-call, not one
 * bound to the caller's own session (see the platform-admin migration). The
 * global interceptor has nothing to record against for such a request
 * (@NoAudit is set on its route for exactly that reason) — so the mutation
 * uses this same capability, with the explicitly-chosen tenant standing in
 * for "the tenant the worker's deadline row named."
 *
 * ===========================================================================
 * WHY THIS IS NOT A SECOND WRITER (R3 survives)
 *
 * There remains exactly ONE function that names `app.audit_append`:
 * `PostgresAuditSink.appendViaClient`, private to that file. This class calls
 * it through `recordOnClient`, contributing nothing of its own beyond
 * "here is the client and tenant you are already provably transacting under."
 * It cannot choose what gets appended, cannot bypass the trigger that computes
 * seq/prev_hash/hash, and cannot write into a tenant's chain other than the one
 * its caller is already bound to (`recordOnClient` proves that bound tenant
 * matches before it will append anything).
 *
 * What makes it SAFE to export, unlike the sink itself: its only public method
 * takes a `PoolClient` the caller must already hold — which nothing outside a
 * `DeadlineHandler` legitimately does — and a full `AuditWrite`, so there is no
 * way to reach it and produce a write with no actor, no reason, or no target
 * beyond what an ordinary annotated entry would have. It is a narrow, typed
 * door, not a hole in the wall the sink lives behind.
 *
 * ===========================================================================
 * WHO MAY CALL THIS, AND HOW
 *
 * Three callers today.
 *
 * Two are worker-side escalation services, both gating the call on the
 * trigger being one the WORKER produces (`sla_proximity` / `sla_breach`),
 * never `'manual'` — a manually-triggered escalation runs through an HTTP
 * route and is already audited the ordinary way; writing here too would
 * double the entry. See `RequestEscalationService.escalate` and
 * `BreachEscalationService.escalate`.
 *
 * The third is `LicensingService.issueForPlatformAdmin`, gated by its route
 * carrying no tenant JWT at all (PlatformAdminGuard, not TenantGuard) rather
 * than by a trigger field — there is no ordinary audited path this could ever
 * double, because a platform-admin request can never carry one.
 *
 *   constructor(private readonly systemAudit: SystemAuditService) {}
 *   ...
 *   await this.systemAudit.record(client, tenantId, {
 *     action: 'request.escalation.fired',
 *     outcome: 'success',
 *     correlationId: randomUUID(),
 *     actorLabel: SYSTEM_WORKER_ESCALATION_ACTOR_LABEL,
 *     targetType: 'request_ticket',
 *     targetId: ticketId,
 *     reason,
 *     afterState: { level, rung, trigger },
 *   });
 *
 * `client` MUST be the exact connection the caller is already transacting on
 * (the one `WorkflowWorker.fire` opened and handed down through `onDeadline`),
 * and `tenantId` MUST be the tenant that transaction is bound to. Passing
 * anything else is refused by `recordOnClient`'s own check, loudly, inside the
 * transaction — never silently redirected.
 * ===========================================================================
 */
@Injectable()
export class SystemAuditService {
  constructor(@Inject(AUDIT_SINK) private readonly sink: PostgresAuditSink) {}

  record(client: PoolClient, tenantId: string, entry: AuditWrite): Promise<AuditReceipt> {
    return this.sink.recordOnClient(client, tenantId, entry);
  }
}
