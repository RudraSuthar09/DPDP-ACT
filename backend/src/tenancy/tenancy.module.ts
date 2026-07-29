import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { PublicApiKeyMiddleware } from './public-api-key.middleware';
import { PortalTenantMiddleware } from './portal-tenant.middleware';
import { TenantGuard } from './tenant.guard';
import { PortalGuard } from './portal.guard';

/**
 * Seam S1 wiring. Global so every module shares the one TenantContextService
 * (and thus the one AsyncLocalStorage). All three middlewares are applied to ALL
 * routes, in this explicit order, so "what establishes tenant context, and in
 * what order" stays reviewable in one file:
 *   1. TenantContextMiddleware — the generic Bearer-JWT edge, every route.
 *   2. PublicApiKeyMiddleware — no-ops immediately outside /consent/public/*;
 *      for those routes, resolves an X-Consent-Api-Key header instead
 *      (FR-CON-09's Consent SDK has no staff JWT to present).
 *   3. PortalTenantMiddleware — no-ops immediately outside /portal/*; for those
 *      routes, resolves the tenant from the URL slug (FR-GRV-01's public request
 *      portal has no credential of any kind to present, by design).
 *
 * Three edges, and only two of them authenticate anything. Read the header of
 * portal-tenant.middleware.ts for why resolving a portal slug is a different
 * KIND of operation from resolving an API key, and why keeping them in separate
 * files with separate database peepholes is the guard against that difference
 * being quietly lost.
 */
@Global()
@Module({
  providers: [TenantContextService, TenantGuard, PortalGuard],
  exports: [TenantContextService, TenantGuard, PortalGuard],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantContextMiddleware, PublicApiKeyMiddleware, PortalTenantMiddleware)
      .forRoutes('*');
  }
}
