import { Module } from '@nestjs/common';
import { CapabilityModule } from '../capability/capability.module';
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
 * Imports CapabilityModule so switching a source INTO gateway_connected mode
 * requires the enterpriseGateway capability (locked architecture §10) — a
 * SaaS/hosted tenant has no Gateway to ever fulfil that mode, so letting it
 * flip the flag would just be confusing dead configuration. Switching back
 * OUT of it never requires the capability (DataSourceService.setMode).
 *
 * Everything else it needs is @Global: TenantDatabaseService/TenantGuard
 * (Seam S1), AuditContextService (S5). Registered in the API root module
 * only — there is nothing here the worker process runs.
 */
@Module({
  imports: [CapabilityModule],
  controllers: [DataSourceController],
  providers: [DataSourceService, DataSourceRepository],
  // Exported so the Gateway control plane (Phase 3C) can verify a source is
  // active + gateway_connected THROUGH this service (R2 — never its own SQL).
  exports: [DataSourceService],
})
export class DataSourceModule {}
