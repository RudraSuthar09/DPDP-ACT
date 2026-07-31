import { Module } from '@nestjs/common';
import { DeadlinePolicyRepository } from './deadline-policy.repository';
import { DeadlinePolicyService } from './deadline-policy.service';

/**
 * The shared versioned-deadline mechanism (FR-BRC-02 / FR-DPR-03).
 *
 * Owns `deadline_policy_versions` and nothing else. Imported by the request
 * substrate (for Grievance and DPRequest) and by Breach — three domains, one
 * table, one resolution rule, one audit story for "who changed a statutory
 * deadline and when".
 *
 * Exports the SERVICE only, never the repository: a module that could reach the
 * repository could INSERT a version without the audit annotation the service
 * attaches, which is the one thing that makes a policy change accountable.
 */
@Module({
  providers: [DeadlinePolicyRepository, DeadlinePolicyService],
  exports: [DeadlinePolicyService],
})
export class DeadlinePolicyModule {}
