import { Module } from '@nestjs/common';
import { ConsentFormsRepository } from './consent-forms.repository';

/**
 * The worker-safe half of the consent forms store — just
 * ConsentFormsRepository, which depends only on the tenant database gateway.
 * Same pattern as RetentionStoreModule: the full ConsentModule imports
 * IdentityModule/NotifyModule/InventoryModule and would boot-crash the
 * worker process. The Enterprise storage sync worker only needs to read
 * pending submissions and mark them synced.
 */
@Module({
  providers: [ConsentFormsRepository],
  exports: [ConsentFormsRepository],
})
export class ConsentFormsStoreModule {}
