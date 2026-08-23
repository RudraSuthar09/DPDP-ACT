import { Module } from '@nestjs/common';
import { StorageStoreModule } from '../storage/storage-store.module';
import { ConsentFormsStoreModule } from '../consent/consent-forms-store.module';
import { DataPrincipalModule } from '../data-principal/data-principal.module';
import { EnterpriseStorageSyncService } from './enterprise-storage-sync.service';

/**
 * Enterprise automatic synchronization (Central DPDP Storage) — worker-safe:
 * only StorageRepository/ConsentFormsRepository/DataPrincipalService, never
 * the full StorageModule/ConsentModule (which would drag GatewayModule/
 * IdentityModule into the worker process and boot-crash it, same trap
 * RetentionStoreModule/RequestStoreModule/BreachStoreModule already avoid).
 *
 * Imported by BOTH ConsentModule (the API process needs
 * EnterpriseStorageSyncService for the synchronous submission-time write —
 * see ConsentFormsService.submit()) and WorkerModule (the periodic catch-up
 * sweep — see enterprise-storage-sync.worker.ts). SystemAuditService comes
 * from AuditModule, which is @Global() already, so it needs no import here.
 */
@Module({
  imports: [StorageStoreModule, ConsentFormsStoreModule, DataPrincipalModule],
  providers: [EnterpriseStorageSyncService],
  exports: [EnterpriseStorageSyncService],
})
export class EnterpriseStorageSyncModule {}
