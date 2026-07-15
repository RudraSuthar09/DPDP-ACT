import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { runWithTenant } from './tenant-connection';

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
    return runWithTenant(this.pool, ctx.tenantId, fn);
  }

  /**
   * Run tenant-scoped work under an EXPLICIT tenant id. Used only where there is
   * no request JWT yet — above all organisation sign-up, which mints a new tenant
   * id and creates the org row under it. Tenant is still mandatory and still
   * fully RLS-enforced; it is simply supplied directly instead of via the JWT.
   */
  withTenantId<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenant(this.pool, tenantId, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
