import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.module';
import { BreachRepository } from './breach.repository';
import { BreachEscalationService } from './breach-escalation.service';

/**
 * The WORKER-SAFE half of the Breach Register.
 *
 * Exactly the split `RequestStoreModule` makes, for exactly the same reason: the
 * worker process must be able to fire a breach deadline and escalate it WITHOUT
 * loading IdentityModule, which would boot-crash it. So the repository and the
 * escalation service live here; everything needing identity, inventory or the
 * audit context lives in BreachModule.
 *
 * If you are tempted to move BreachService in here so the worker can call it —
 * that is the crash. The worker does not need it: a fired deadline escalates
 * from the snapshot already on its own row.
 */
@Module({
  imports: [NotifyModule],
  providers: [BreachRepository, BreachEscalationService],
  exports: [BreachRepository, BreachEscalationService],
})
export class BreachStoreModule {}
