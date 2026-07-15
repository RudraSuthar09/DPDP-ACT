import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@dpdp/shared';

/**
 * Holds the per-request tenant context in AsyncLocalStorage (ALS). The context
 * is populated once, at the edge, by TenantContextMiddleware, and then flows
 * automatically through every async hop of the request — controllers, services,
 * and ultimately the database layer — without being threaded through function
 * signatures. This is the "async-local context" step of Seam S1.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContext>();

  /** Run `fn` (and everything it awaits) with `ctx` as the ambient tenant. */
  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  /** The current tenant context, or undefined on an unauthenticated code path. */
  get(): TenantContext | undefined {
    return this.als.getStore();
  }

  /**
   * The current tenant context, or throw. This is the fail-closed choke point:
   * the database layer calls it before every tenant-scoped query, so there is no
   * way to run one without a tenant — even if a route forgot its guard.
   */
  getOrThrow(): TenantContext {
    const ctx = this.als.getStore();
    if (!ctx) {
      throw new Error(
        'No tenant context in scope — refusing to run a tenant-scoped query (Seam S1).',
      );
    }
    return ctx;
  }
}
