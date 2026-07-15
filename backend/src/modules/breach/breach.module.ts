import { Module } from '@nestjs/common';

/**
 * Breach Register. Guided incident workflow with gates and escalating deadline
 * alerts, driven by versioned deadline policies (data, NOT code — FR-BRC-02).
 * Deadlines run through the WorkflowRunner seam (S3). Evidence is hash-recorded;
 * closure produces a sealed PDF packet.
 *
 * Requirements: FR-BRC-01..07.  Seams: S3.  Invariants: I4.
 * Skeleton only — no providers or controllers yet.
 */
@Module({})
export class BreachModule {}
