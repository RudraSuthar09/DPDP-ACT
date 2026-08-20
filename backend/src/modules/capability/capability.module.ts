import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';
import { CapabilityRepository } from './capability.repository';
import { CapabilityGuard } from './capability.guard';

/**
 * The centralized capability model (locked architecture §10): resolves
 * plan/deploymentType/features for the current tenant from its active
 * license (LicensingModule, imported — R2, never this module's own SQL for
 * license state) with a fallback to organisations.plan/deployment_type.
 * Exports CapabilityService + CapabilityGuard so other modules (Gateway,
 * Installation) can enforce capabilities without reaching into this one's
 * internals.
 */
@Module({
  imports: [LicensingModule],
  controllers: [CapabilityController],
  providers: [CapabilityService, CapabilityRepository, CapabilityGuard],
  exports: [CapabilityService, CapabilityGuard],
})
export class CapabilityModule {}
