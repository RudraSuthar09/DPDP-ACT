import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { PublicApiKeyMiddleware } from './public-api-key.middleware';
import { TenantGuard } from './tenant.guard';

/**
 * Seam S1 wiring. Global so every module shares the one TenantContextService
 * (and thus the one AsyncLocalStorage). Both middlewares are applied to ALL
 * routes, in this explicit order, so "what establishes tenant context, and in
 * what order" stays reviewable in one file:
 *   1. TenantContextMiddleware — the generic Bearer-JWT edge, every route.
 *   2. PublicApiKeyMiddleware — no-ops immediately outside /consent/public/*;
 *      for those routes, resolves an X-Consent-Api-Key header instead
 *      (FR-CON-09's Consent SDK has no staff JWT to present).
 */
@Global()
@Module({
  providers: [TenantContextService, TenantGuard],
  exports: [TenantContextService, TenantGuard],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware, PublicApiKeyMiddleware).forRoutes('*');
  }
}
