import { Module } from '@nestjs/common';
import { RetentionRepository } from './retention.repository';

/**
 * The worker-safe half of retention tracking — just RetentionRepository, which
 * depends only on the tenant database gateway. Same pattern as
 * RequestStoreModule / BreachStoreModule: importing the whole ConsentModule into
 * the worker would drag in IdentityModule and boot-crash that process, so the
 * one thing the RetentionDeadlineHandler needs is exported on its own.
 */
@Module({
  providers: [RetentionRepository],
  exports: [RetentionRepository],
})
export class RetentionStoreModule {}
