import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { CapabilityModule } from '../capability/capability.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { StorageRepository } from './storage.repository';
import { StorageGatewayService } from './storage-gateway.service';
import { StorageGatewayRepository } from './storage-gateway.repository';

/**
 * Storage & Folder Mapping — the persistent, generic control-plane foundation
 * for "where does this DPDP module/template file its artefacts". A
 * deliberately small, self-contained module: Storage Root -> Folder -> Module
 * Mapping, CONFIGURATION ONLY. No file I/O, no document content, no customer
 * value — see the migration header and storage.repository.ts.
 *
 * Imports GatewayModule (through its GatewayService export only, R2) so a
 * 'gateway' storage root can verify the referenced device belongs to THIS
 * tenant before binding — the tenant-scoped SELECT that GatewayService runs
 * under RLS is the actual enforcement (a plain foreign key does not apply RLS
 * during its own referential-integrity check, so this lookup is load-bearing,
 * not a redundant nicety; see storage.service.ts).
 *
 * Imports CapabilityModule so a 'gateway'-provider root requires the
 * `enterpriseGateway` capability (StorageService.createRoot) and the
 * staff-facing pairing route is gated the same way (StorageController) —
 * locked architecture §10, same enforcement primitive GatewayModule itself
 * uses for linking a device to a client_server installation.
 *
 * Everything else it needs is @Global: TenantDatabaseService/TenantGuard
 * (Seam S1), AuditContextService (S5). Registered in the API root module
 * only. Exported so an owning module (Consent Register today; Data
 * Inventory/DSR/Grievance/Breach later) can resolve/set a mapping THROUGH
 * this service (R2 — never its own SQL against these tables).
 */
@Module({
  imports: [GatewayModule, CapabilityModule],
  controllers: [StorageController],
  providers: [StorageService, StorageRepository, StorageGatewayService, StorageGatewayRepository],
  exports: [StorageService],
})
export class StorageModule {}
