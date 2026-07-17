import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/**
 * A request-scoped unit of work: ONE database transaction for the whole request,
 * so the business change and its audit entry commit together or not at all.
 *
 * WHY THIS EXISTS
 *
 * The obvious way to write an audit interceptor is: let the handler commit its
 * work, then open a second transaction and append the entry. That produces an
 * audit log which is usually right — and "usually" is not a standard you can
 * testify to. If the append fails after the handler committed, a change exists
 * with no evidence of it, which is precisely the state invariant I4 exists to
 * make impossible. The failure is rare, silent, and unrecoverable: you cannot
 * notice it later, because the only thing that would have told you is the entry
 * that was never written.
 *
 * So the interceptor owns the transaction instead. Every `withTenant()` inside
 * the request JOINS this unit of work rather than opening its own, the audit
 * entry is appended on that same connection, and the commit at the end makes the
 * change and its evidence a single atomic fact.
 *
 * WHY IT IS LAZY
 *
 * The slot is installed empty and the transaction is opened by the first
 * database call that needs it. That is what makes registration auditable: at the
 * start of `POST /auth/register` there is no tenant yet — the handler mints it —
 * so a transaction opened up-front would have no tenant to bind the GUC to. By
 * opening on first use, the transaction is bound to the tenant the handler just
 * created, and the audit entry lands inside it.
 *
 * WHAT HAPPENS OUTSIDE A REQUEST
 *
 * The worker, tests, and any non-HTTP path never install a slot, so
 * `withTenant()` behaves exactly as it always has: its own transaction, opened
 * and committed per call. This is an addition, not a change.
 */

export interface UnitOfWorkSlot {
  client: PoolClient | null;
  tenantId: string | null;
  /** Set once the interceptor has committed or rolled back. Later database calls
   *  in the same request (e.g. recording a failure) get their own transaction
   *  rather than writing into a finished one. */
  closed: boolean;
}

@Injectable()
export class UnitOfWorkService {
  private readonly als = new AsyncLocalStorage<UnitOfWorkSlot>();

  /** Run `fn` with an empty unit-of-work slot in scope. Only the interceptor calls this. */
  run<T>(fn: (slot: UnitOfWorkSlot) => Promise<T>): Promise<T> {
    const slot: UnitOfWorkSlot = { client: null, tenantId: null, closed: false };
    return this.als.run(slot, () => fn(slot));
  }

  /** The active slot, or undefined outside a request. */
  current(): UnitOfWorkSlot | undefined {
    return this.als.getStore();
  }
}
