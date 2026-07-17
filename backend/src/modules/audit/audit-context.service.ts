import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/**
 * How a service contributes to its audit entry WITHOUT writing one (R3).
 *
 * The interceptor knows the request: who, from where, when, the correlation id,
 * whether it succeeded. What it cannot know is the domain: which user was
 * suspended, what their status was before, why. Only the service knows that —
 * and it knows it in the middle of a transaction, where the before-state is
 * still readable.
 *
 * So the split is: services ANNOTATE, the interceptor WRITES. A service says
 * "here is what I changed"; it never says "here is a row for the audit log". The
 * distinction is not stylistic — this class has no database access at all, so
 * annotating cannot become writing however hard a future caller leans on it. The
 * sink that can actually append is not exported from AuditModule, so no service
 * can inject it even by name.
 *
 * The annotation lives in AsyncLocalStorage, so a service reached three layers
 * down contributes to the entry without anyone threading an audit object through
 * the call signatures — the same trick, and the same reasoning, as the tenant
 * context in Seam S1.
 */

export interface AuditAnnotation {
  /** Overrides the action name for this request (usually set by @Audited). */
  action?: string;
  /** WHO, when the request had no authenticated user — registration mints its own. */
  actorId?: string | null;
  actorLabel?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}

@Injectable()
export class AuditContextService {
  private readonly als = new AsyncLocalStorage<AuditAnnotation>();

  /** Install an empty annotation for the request. Only the interceptor calls this. */
  run<T>(fn: (annotation: AuditAnnotation) => Promise<T>): Promise<T> {
    const annotation: AuditAnnotation = {};
    return this.als.run(annotation, () => fn(annotation));
  }

  /**
   * Add facts about what this request is doing. Merges, so a controller can name
   * the target and a service deeper down can fill in before/after independently.
   *
   * Outside a request (worker, tests) this is a no-op rather than an error: a
   * service should not have to care whether it is being called from HTTP, and an
   * un-annotated audit entry is a smaller problem than a crashed job.
   */
  annotate(facts: AuditAnnotation): void {
    const current = this.als.getStore();
    if (!current) {
      return;
    }
    Object.assign(current, facts);
  }

  current(): AuditAnnotation | undefined {
    return this.als.getStore();
  }
}
