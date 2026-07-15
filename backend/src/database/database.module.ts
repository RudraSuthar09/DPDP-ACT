import { Global, Module } from '@nestjs/common';
import { TenantDatabaseService } from './database.service';

/**
 * Global so every feature module injects the same tenant-scoped database
 * gateway. Depends on TenantContextService (provided globally by TenancyModule).
 */
@Global()
@Module({
  providers: [TenantDatabaseService],
  exports: [TenantDatabaseService],
})
export class DatabaseModule {}
