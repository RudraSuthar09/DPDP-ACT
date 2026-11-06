import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { PASSWORD_HASHER, ScryptPasswordHasher } from '../identity/crypto/password-hasher';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminRepository } from './platform-admin.repository';

/**
 * The cross-tenant support tool (`/admin/licenses` on the frontend): issue or
 * view license keys for any client org. Owns `platform_admins` only (R2) and
 * depends on LicensingModule through its service export, same as
 * InstallationModule — never another module's SQL.
 *
 * PASSWORD_HASHER is bound again here (not imported from IdentityModule,
 * which does not export that token) — it is a stateless crypto primitive, so
 * a second provider instance costs nothing and keeps this module's
 * dependency surface to LicensingModule alone.
 */
@Module({
  imports: [LicensingModule],
  controllers: [PlatformAdminController],
  providers: [PlatformAdminService, PlatformAdminRepository, { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher }],
})
export class PlatformAdminModule {}
