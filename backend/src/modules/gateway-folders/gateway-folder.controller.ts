import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import type { RequestWithGatewayDevice } from '../../tenancy/gateway-device.middleware';
import { AllowGatewayDevice, Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { GatewayFolderService } from './gateway-folder.service';
import { parseAuthorizeFolder, parseRevokeFolder } from './gateway-folder.dto';

/** Removing a folder is a configuration change of the same weight as adding
 *  a data source, so it takes the same roles. */
const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Four routes, two audiences:
 *
 *   POST /gateway/folders              (DEVICE) "my administrator authorized
 *                                      this folder — give me its record ids"
 *   GET  /gateway/folders/revocations  (DEVICE) "which of the records I hold
 *                                      have been revoked?"
 *   POST /gateway/folders/revoke       (STAFF)  "remove this folder"
 *   GET  /gateway/folders/pending-removals (STAFF) "which removals has the
 *                                      Gateway not applied yet?"
 *
 * The split matters: a device may ASK what it has lost, and may never decide
 * it. Removal is a staff action, authenticated and role-checked like every
 * other configuration change, so a compromised Gateway cannot revoke (or
 * un-revoke) anything.
 *
 * The two device routes are reached only by an enrolled Gateway presenting
 * its device token (the SAME mechanism as heartbeat/claim; no new auth
 * scheme). Between them they are what removes hand-copied ids from Gateway
 * Setup in both directions. The staff routes on /data-sources and /storage
 * are untouched and still require staff authentication, roles and capability
 * checks — see gateway-folder.service.ts for the full security boundary.
 */
@Controller('gateway/folders')
export class GatewayFolderController {
  constructor(private readonly folders: GatewayFolderService) {}

  @Post()
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.folder.authorized')
  @HttpCode(HttpStatus.OK)
  async authorize(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    // Identity NEVER comes from the body — only from the verified token.
    if (!req.gatewayDeviceId) throw new UnauthorizedException('A valid device token is required.');
    return this.folders.authorize(req.gatewayDeviceId, parseAuthorizeFolder(body));
  }

  /** Device-facing, read-only: the ids this Gateway must stop serving. */
  @Get('revocations')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  async revocations(@Req() req: RequestWithGatewayDevice) {
    if (!req.gatewayDeviceId) throw new UnauthorizedException('A valid device token is required.');
    return this.folders.revocationsFor(req.gatewayDeviceId);
  }

  /** Staff-facing: "Remove folder" in Sources & Storage. Keyed by the label
   *  the customer sees, so no id is ever put in front of them. */
  @Post('revoke')
  @UseGuards(TenantGuard)
  @Roles(...MANAGE)
  @Audited('gateway.folder.revoked')
  @HttpCode(HttpStatus.OK)
  async revoke(@Body() body: unknown) {
    return this.folders.revoke(parseRevokeFolder(body));
  }

  /** Staff-facing: removals the Gateway has not applied yet, so the UI can
   *  say "Removal pending" rather than claim success. Labels only. */
  @Get('pending-removals')
  @UseGuards(TenantGuard)
  async pendingRemovals() {
    return { removals: await this.folders.pendingRemovals() };
  }
}
