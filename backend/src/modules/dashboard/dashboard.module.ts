import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ConsentModule } from '../consent/consent.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Compliance dashboard (FR-DSH-01). Pulls counters and activity from other
 * modules entirely through their exported services (R2) — WorkflowJobsRepository
 * and AuditVerifierService come in as @Global exports (WorkflowModule, AuditModule)
 * without needing an explicit import here, the same way RegisterService already
 * consumes AuditContextService without importing AuditModule.
 */
@Module({
  imports: [InventoryModule, ConsentModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
