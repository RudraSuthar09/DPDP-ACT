import { Module } from '@nestjs/common';
import { LicensingController } from './licensing.controller';
import { LicensingService } from './licensing.service';
import { LicensingRepository } from './licensing.repository';

/**
 * Licensing (locked-architecture foundation phase): issue/validate/activate/
 * revoke license entitlements. Owns the `licenses` table only (R2). Exported
 * so InstallationModule can validate a presented key through this service —
 * never its own SQL.
 */
@Module({
  controllers: [LicensingController],
  providers: [LicensingService, LicensingRepository],
  exports: [LicensingService],
})
export class LicensingModule {}
