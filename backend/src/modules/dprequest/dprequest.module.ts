import { Module } from '@nestjs/common';
import { DPRequestController } from './dprequest.controller';
import { DPRequestService } from './dprequest.service';

/**
 * Data Principal Request Tracker. Handles RIGHTS REQUESTS (DPDP §§11–14). Sits on
 * the shared substrate owned by Grievance; the statutory SLA deadline (FR-DPR-03)
 * runs on the WorkflowRunner (S3) — the same mechanism as Breach and Grievance.
 *
 * Requirements: FR-DPR-01..06, 08, 09.  Seams: S3.  Invariants: I1, I2, I4.
 * Stage 1: the SLA-deadline path through S3. The two-tier Personal Data Summary
 * and fulfilment webhooks land later.
 */
@Module({
  controllers: [DPRequestController],
  providers: [DPRequestService],
})
export class DPRequestModule {}
