import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantGuard } from './tenant.guard';

/**
 * Seam S1 wiring. Global so every module shares the one TenantContextService
 * (and thus the one AsyncLocalStorage). The middleware is applied to ALL routes
 * so tenant context is established at the edge for every request.
 */
@Global()
@Module({
  providers: [TenantContextService, TenantGuard],
  exports: [TenantContextService, TenantGuard],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
