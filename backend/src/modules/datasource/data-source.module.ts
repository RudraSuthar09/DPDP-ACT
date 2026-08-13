import { Module } from '@nestjs/common';
import { DataSourceController } from './data-source.controller';
import { DataSourceService } from './data-source.service';
import { DataSourceRepository } from './data-source.repository';

/**
 * Data Sources (Phase 1 of the Gateway line of work). A deliberately small,
 * self-contained module that owns the CENTRAL METADATA for a client's data
 * sources and their per-source access mode (I1/§2.1) — nothing more.
 *
 * It contains NO Gateway, NO connector, NO raw-read capability. Its entire
 * surface is metadata CRUD + the audited access-mode toggle. Kept separate from
 * the inventory module so the future Gateway concern can grow here in isolation
 * (R2) rather than entangling the metadata-only data map.
 *
 * Everything it needs is @Global: TenantDatabaseService/TenantGuard (Seam S1),
 * AuditContextService (S5). Registered in the API root module only — there is
 * nothing here the worker process runs.
 */
@Module({
  controllers: [DataSourceController],
  providers: [DataSourceService, DataSourceRepository],
})
export class DataSourceModule {}
