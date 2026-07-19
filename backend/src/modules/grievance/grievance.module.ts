import { Module } from '@nestjs/common';
import { GrievanceController } from './grievance.controller';
import { GrievanceService } from './grievance.service';

/**
 * Grievance Register. Handles COMPLAINTS (DPDP §13). Owns the shared request
 * substrate reused by DPRequest: public portal, OTP verification, ticket
 * lifecycle, SLA timers via WorkflowRunner (S3), and the escalation ladder.
 *
 * Requirements: FR-GRV-01..07.  Seams: S3.  Invariants: I1, I4.
 * Stage 1: the SLA-deadline path through S3, proving the shared substrate.
 */
@Module({
  controllers: [GrievanceController],
  providers: [GrievanceService],
})
export class GrievanceModule {}
