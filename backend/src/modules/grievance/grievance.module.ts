import { Module } from '@nestjs/common';

/**
 * Grievance Register. Handles COMPLAINTS (DPDP §13). Owns the shared request
 * substrate reused by DPRequest: branded public portal, OTP contact
 * verification, the identity-verification handoff (platform orchestrates, client
 * identifies — FR-GRV-04), ticket lifecycle, SLA timers via WorkflowRunner (S3),
 * and the escalation ladder.
 *
 * Requirements: FR-GRV-01..07.  Seams: S3.  Invariants: I1, I4.
 * Skeleton only — no providers or controllers yet.
 */
@Module({})
export class GrievanceModule {}
