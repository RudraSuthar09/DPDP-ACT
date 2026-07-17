import { Global, Module } from '@nestjs/common';
import { TenantDatabaseService } from './database.service';
import { UnitOfWorkService } from './unit-of-work';

/**
 * Global so every feature module injects the same tenant-scoped database
 * gateway. Depends on TenantContextService (provided globally by TenancyModule).
 *
 * UnitOfWorkService is global for the same reason it must be a singleton: it
 * holds the AsyncLocalStorage that lets a request's database calls and its audit
 * entry share one transaction (Seam S5). Two instances would mean two stores and
 * silently separate transactions.
 */
@Global()
@Module({
  providers: [TenantDatabaseService, UnitOfWorkService],
  exports: [TenantDatabaseService, UnitOfWorkService],
})
export class DatabaseModule {}
