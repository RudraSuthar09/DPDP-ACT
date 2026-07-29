import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { UserStatus } from '@dpdp/shared';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { runWithTenant } from './tenant-connection';
import { UnitOfWorkService } from './unit-of-work';

/** What the login peephole returns — ids only, never credential material. */
export interface LoginResolution {
  userId: string;
  tenantId: string;
  status: UserStatus;
}

/** What the Consent SDK API-key peephole returns — ids only, never the hash. */
export interface ConsentApiKeyResolution {
  tenantId: string;
  keyId: string;
  createdBy: string;
  revokedAt: string | null;
}

/**
 * The tenant-scoped database gateway. Every module that touches the database
 * does so through this service — there is deliberately NO generic `query()` that
 * runs outside a tenant, so a tenant-scoped query without a tenant is not
 * expressible.
 *
 * The pool connects as `dpdp_app`: a least-privilege role that is NOT the table
 * owner and is NOSUPERUSER NOBYPASSRLS. That is essential — RLS is silently
 * bypassed for superusers and table owners, so the app must never be either.
 */
@Injectable()
export class TenantDatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantDatabaseService.name);
  private readonly pool: Pool;

  constructor(
    config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly uow: UnitOfWorkService,
  ) {
    const connectionString = config.get<string>('APP_DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'APP_DATABASE_URL is required. The app must connect as the least-privilege, ' +
          'RLS-enforced role (dpdp_app) — never the owner/superuser used for migrations. ' +
          'See Seam S1.',
      );
    }
    this.pool = new Pool({ connectionString, max: 10 });
    this.logger.log('Tenant database pool initialised (role: dpdp_app, RLS enforced)');
  }

  /**
   * Run tenant-scoped work using the tenant from the current request context.
   * Throws (fail closed) if there is no tenant context in scope.
   */
  withTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = this.tenantContext.getOrThrow();
    return this.runScoped(ctx.tenantId, fn);
  }

  /**
   * Run tenant-scoped work under an EXPLICIT tenant id. Used only where there is
   * no request JWT yet — above all organisation sign-up, which mints a new tenant
   * id and creates the org row under it. Tenant is still mandatory and still
   * fully RLS-enforced; it is simply supplied directly instead of via the JWT.
   */
  withTenantId<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.runScoped(tenantId, fn);
  }

  /**
   * Join the request's unit of work if one is open; otherwise behave exactly as
   * before — own transaction, opened and committed per call.
   *
   * Joining is what lets the audit interceptor commit an entry in the SAME
   * transaction as the change it describes (see unit-of-work.ts). Outside an
   * HTTP request — the worker, the isolation suite — there is no slot and this
   * is a straight pass-through to runWithTenant.
   */
  private async runScoped<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const slot = this.uow.current();
    if (!slot || slot.closed) {
      return runWithTenant(this.pool, tenantId, fn);
    }

    if (!slot.client) {
      // First database call of the request: open the transaction and bind the
      // tenant, in that order, on the connection everything else will share.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      } catch (err) {
        client.release();
        throw err;
      }
      slot.client = client;
      slot.tenantId = tenantId;
    } else if (slot.tenantId !== tenantId) {
      // One request, one tenant. A second tenant inside the same transaction
      // would run under the first one's GUC and either read nothing or write to
      // the wrong chain — fail loudly instead of quietly doing the wrong thing.
      throw new Error(
        `Refusing to run work for tenant ${tenantId} inside a unit of work already bound to ` +
          `${slot.tenantId} (Seam S1). One request touches one tenant.`,
      );
    }

    return fn(slot.client);
  }

  /**
   * Run tenant-scoped work in its OWN transaction, DETACHED from the request's
   * unit of work — so it survives even when the request is rejected.
   *
   * This exists for one situation, and the situation is a trap worth spelling
   * out. Since the audit interceptor rolls the request transaction back on any
   * error, a wrong password would roll back the very thing a wrong password is
   * supposed to cause: the increment of the failed-attempt counter. The lockout
   * would then never trigger, brute-force protection would be silently gone, and
   * nothing would look broken — every test of the happy path would still pass.
   *
   * So: bookkeeping that must outlive a rejection goes here. Business writes do
   * NOT — they belong in the request transaction with their audit entry, and
   * putting one here is how you get a change with no evidence of it (I4).
   */
  withTenantIdDetached<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenant(this.pool, tenantId, fn);
  }

  /**
   * The tenant this request's transaction is (or was) bound to.
   *
   * Deliberately still answers after the unit of work has closed. A rejected
   * login rolls the transaction back and THEN records the attempt — and it is
   * the same tenant either way, because the tenant is a fact about the request,
   * not about the transaction. Forgetting it on rollback would leave every
   * failed login on an unauthenticated route unattributable, and therefore
   * unrecorded: exactly the events most worth keeping.
   */
  unitOfWorkTenantId(): string | null {
    return this.uow.current()?.tenantId ?? null;
  }

  /**
   * Commit the request's transaction. Called by the audit interceptor AFTER the
   * audit entry has been appended to it — so a failure to record evidence takes
   * the business change down with it, rather than leaving a change nobody can
   * account for.
   */
  async commitUnitOfWork(): Promise<void> {
    await this.finishUnitOfWork('COMMIT');
  }

  async rollbackUnitOfWork(): Promise<void> {
    await this.finishUnitOfWork('ROLLBACK');
  }

  private async finishUnitOfWork(verb: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    const slot = this.uow.current();
    if (!slot || slot.closed) {
      return;
    }
    slot.closed = true;
    const client = slot.client;
    slot.client = null;
    if (!client) {
      // The handler never touched the database — nothing to commit.
      return;
    }
    try {
      await client.query(verb);
    } finally {
      client.release();
    }
  }

  /**
   * The ONE pre-tenant operation on the platform: "which tenant does this login
   * belong to?" — the question that cannot be asked under a tenant context,
   * because the answer IS the tenant. See the header of the identity migration
   * for the full reasoning.
   *
   * It lives here, spelled out by name, rather than as a general `query()` that
   * runs without a tenant, precisely so that it is the only one. There is no
   * untenanted query primitive to reach for: adding a second exception means
   * writing a second method here, in a file where that decision is visible in
   * review, instead of quietly calling a generic helper from a service.
   *
   * The narrowness is enforced by the database, not by this comment: dpdp_app
   * has no privileges on `app.user_directory` at all, and `app.resolve_login` is
   * a SECURITY DEFINER function taking an exact email and returning three ids —
   * no credential material, no listing, no pattern matching. Everything after
   * this call runs inside `withTenantId()` under full RLS.
   */
  async resolveLogin(email: string): Promise<LoginResolution | null> {
    const { rows } = await this.pool.query<LoginResolution>(
      'SELECT user_id AS "userId", tenant_id AS "tenantId", status FROM app.resolve_login($1)',
      [email.trim().toLowerCase()],
    );
    return rows[0] ?? null;
  }

  /**
   * The second pre-tenant peephole: "which tenant does this Consent SDK
   * public API key belong to?" (FR-CON-09). Same reasoning as resolveLogin
   * above — the answer IS the tenant, so it cannot be asked under one.
   *
   * dpdp_app has EXECUTE on app.resolve_public_api_key() and nothing else
   * that would let it enumerate consent_api_keys across tenants; the exact
   * key hash is the only thing that gets a row back. Revocation is NOT
   * filtered in SQL — the caller checks `revokedAt`, so a revoked key
   * resolves (and can be reported as "revoked") rather than looking
   * indistinguishable from a key that never existed.
   */
  async resolveConsentApiKey(keyHash: string): Promise<ConsentApiKeyResolution | null> {
    const { rows } = await this.pool.query<ConsentApiKeyResolution>(
      'SELECT tenant_id AS "tenantId", key_id AS "keyId", created_by AS "createdBy", ' +
        'revoked_at AS "revokedAt" FROM app.resolve_public_api_key($1)',
      [keyHash],
    );
    return rows[0] ?? null;
  }

  /**
   * Run `fn` on a pooled connection with NO tenant bound.
   *
   * This does NOT bypass RLS: the connection is still dpdp_app, so any query
   * against a tenant table returns zero rows (app.current_tenant() is NULL and
   * `tenant_id = NULL` is never true — fail closed, exactly like a forgotten
   * WHERE). Its ONLY legitimate use is calling a SECURITY DEFINER scheduler
   * peephole that deliberately returns cross-tenant ids — the sibling of
   * resolveLogin for the login path (Seam S3's reconciliation ticker). Anything
   * tenant-scoped must go through withTenant/withTenantId instead; there is no
   * generic untenanted query primitive, and this is deliberately not one.
   */
  async runUntenanted<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
