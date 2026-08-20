import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { CapabilityModule } from '../capability/capability.module';
import { InstallationController } from './installation.controller';
import { InstallationService } from './installation.service';
import { InstallationRepository } from './installation.repository';

/**
 * Installation registration (locked-architecture foundation phase). Owns the
 * `installations` table only (R2). Depends on LicensingModule (validate a
 * presented key) and CapabilityModule (return resolved capabilities on
 * registration) through their service exports — never another module's SQL.
 * Exported so GatewayModule can read installation state when linking a
 * device (PATCH /gateway/devices/:id/installation).
 */
@Module({
  imports: [LicensingModule, CapabilityModule],
  controllers: [InstallationController],
  providers: [InstallationService, InstallationRepository],
  exports: [InstallationService],
})
export class InstallationModule {}
