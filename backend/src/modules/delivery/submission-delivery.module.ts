import { Module } from '@nestjs/common';
import { StorageStoreModule } from '../storage/storage-store.module';
import { SubmissionDeliveryController } from './submission-delivery.controller';
import { SubmissionDeliveryService } from './submission-delivery.service';
import { SubmissionDeliveryRepository } from './submission-delivery.repository';
import { SubmissionDeliveryCipher } from './submission-delivery-crypto';

/**
 * The submission delivery queue (see submission-delivery.service.ts's header
 * for the full "why" — a documented CLAUDE.md I1/R6 exception). API-process
 * only: every route here is HTTP, and the worker has no HTTP listener.
 *
 * StorageStoreModule (not the full StorageModule) for StorageRepository —
 * the same worker-safe, GatewayModule/IdentityModule-free import
 * EnterpriseStorageSyncModule already uses, so this module stays equally
 * safe to import anywhere without dragging in unrelated dependencies.
 *
 * Imported by ConsentModule (ConsentFormsService.submit() stages a delivery)
 * and registered directly in AppModule for its own controller.
 */
@Module({
  imports: [StorageStoreModule],
  controllers: [SubmissionDeliveryController],
  providers: [SubmissionDeliveryService, SubmissionDeliveryRepository, SubmissionDeliveryCipher],
  exports: [SubmissionDeliveryService],
})
export class SubmissionDeliveryModule {}
