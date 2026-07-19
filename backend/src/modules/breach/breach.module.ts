import { Module } from '@nestjs/common';
import { BreachController } from './breach.controller';
import { BreachService } from './breach.service';

/**
 * Breach Register. Guided incident workflow with escalating deadline alerts,
 * driven by versioned deadline policies (data, NOT code — FR-BRC-02). Deadlines
 * run through the WorkflowRunner seam (S3), injected as WORKFLOW_RUNNER — the same
 * runner Grievance and DPRequest use, because all three share the same physics.
 *
 * Requirements: FR-BRC-01..07.  Seams: S3.  Invariants: I4.
 * Stage 1: the deadline path through S3. The full incident model (tasks, evidence
 * hashes, sealed PDF packet) lands in a later migration.
 */
@Module({
  controllers: [BreachController],
  providers: [BreachService],
})
export class BreachModule {}
