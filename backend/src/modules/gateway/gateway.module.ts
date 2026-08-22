import { Module } from '@nestjs/common';
import { DataSourceModule } from '../datasource/data-source.module';
import { TokenService } from '../identity/token.service';
import { InstallationModule } from '../installation/installation.module';
import { CapabilityModule } from '../capability/capability.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewayRepository } from './gateway.repository';

/**
 * The Gateway CONTROL PLANE (Phase 3C): enrolment → pairing → session, heartbeat,
 * revocation, de-enrolment for an Enterprise Local Gateway.
 *
 * It owns ids, hashes and metadata only — NO connector, NO raw-read, NO customer
 * data (I1). It reuses the platform's existing primitives rather than inventing a
 * second auth system: Seam-S1 tenant context + RLS (@Global TenantDatabaseService),
 * the S5 audit interceptor (@Global AuditContextService), the JWT signer
 * (TokenService) for the device token, and DataSourceService (imported) to check a
 * source is Gateway-connected. The device/enrolment tenant-context edges live in
 * the tenancy module alongside the other credential edges.
 *
 * Locked-architecture foundation phase additive: also imports
 * InstallationModule (link a device to the Installation it runs inside, and
 * touch that installation's heartbeat) and CapabilityModule (gate linking to
 * an Enterprise-flavoured installation) — through their service exports
 * only, never this module's own SQL (R2). Neither changes anything about the
 * existing enroll/pair/session/heartbeat/revoke flow.
 *
 * API-process only — the worker runs nothing here.
 */
@Module({
  imports: [DataSourceModule, InstallationModule, CapabilityModule],
  controllers: [GatewayController],
  providers: [GatewayService, GatewayRepository, TokenService],
  // Exported so a later module (e.g. Storage & Folder Mapping, binding a
  // storage root to a Gateway device) can verify a device THROUGH this
  // service (R2 — never its own SQL against gateway_devices).
  exports: [GatewayService],
})
export class GatewayModule {}
