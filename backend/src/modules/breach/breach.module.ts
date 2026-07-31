import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { DeadlinePolicyModule } from '../deadlines/deadline-policy.module';
import { BreachStoreModule } from './breach-store.module';
import { BreachController } from './breach.controller';
import { BreachService } from './breach.service';
import { BreachDeadlineService } from './breach-deadline.service';

/**
 * Breach Register — incident workflow, versioned statutory deadlines,
 * escalating alerts, evidence attestation and the sealed closure packet.
 *
 * Requirements: FR-BRC-01…07.  Seams: S1, S3, S5.  Invariants: I1, I3, I4.
 *
 * What it imports, and why each is a SERVICE dependency rather than a table read:
 *   DeadlinePolicyModule — the shared versioned-deadline register (FR-BRC-02),
 *     the same one Grievance and DPRequest resolve against. One mechanism, so
 *     "what deadline was in force" has one answer across the whole platform.
 *   InventoryModule      — RopaService, for the real data categories an incident
 *     references (FR-BRC-01). Breach never touches an inventory table.
 *   IdentityModule       — who holds each escalation rung, and the organisation
 *     name for the closure packet.
 *   BreachStoreModule    — the worker-safe repository/escalation pair.
 *
 * The consuming half of S3 (BreachDeadlineHandler) is deliberately NOT a
 * provider here: like RequestDeadlineHandler it is registered only in
 * WorkerModule, so the API schedules deadlines and only the worker fires them.
 */
@Module({
  imports: [BreachStoreModule, DeadlinePolicyModule, InventoryModule, IdentityModule],
  controllers: [BreachController],
  providers: [BreachService, BreachDeadlineService],
})
export class BreachModule {}
