import { Module } from '@nestjs/common';
import { StorageRepository } from './storage.repository';

/**
 * The worker-safe half of Storage & Folder Mapping — just StorageRepository,
 * which depends only on the tenant database gateway. Same pattern as
 * RetentionStoreModule/RequestStoreModule/BreachStoreModule: the full
 * StorageModule imports GatewayModule (for the 'gateway' provider's device
 * check), and GatewayModule pulls in IdentityModule, which would boot-crash
 * the worker process. The Enterprise storage sync worker never touches
 * 'gateway' roots at all, so it only ever needs the repository.
 */
@Module({
  providers: [StorageRepository],
  exports: [StorageRepository],
})
export class StorageStoreModule {}
