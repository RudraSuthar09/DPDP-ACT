import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import type { RequestWithGatewayDevice } from '../../tenancy/gateway-device.middleware';
import type { RequestWithGatewayEnrollment } from '../../tenancy/gateway-enrollment.middleware';
import { Roles, AllowGatewayDevice } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { GatewayService } from './gateway.service';
import {
  parseCreateEnrollment,
  parseCreatePairing,
  parseHeartbeat,
  parseRedeemPairing,
  parseRefreshSession,
  parseRevokeReason,
} from './gateway.dto';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * The Gateway CONTROL PLANE (Phase 3C). Two kinds of caller, never mixed:
 *
 *   STAFF (browser, normal access-token + RBAC): issue an enrolment code, create
 *   a pairing nonce for a source+device, list/revoke devices.
 *
 *   DEVICE (an enrolled Gateway, outbound HTTPS): enrol (with an enrolment code),
 *   heartbeat, redeem a pairing → session, refresh a session, de-enrol. These
 *   carry a `x-gateway-enrollment-code` or `x-gateway-device-token` header (NOT a
 *   human JWT); the tenancy middleware establishes their context.
 *
 * THERE IS NO RAW-DATA ROUTE HERE, AND THERE MUST NEVER BE ONE. This controller
 * moves ids, hashes and metadata only — no /source/read, no /rows, no /data. The
 * data plane (browser ↔ Gateway, direct) is a separate, later capability and
 * never routes customer values through this central API (I1).
 */
@Controller('gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  // --- staff ---------------------------------------------------------------

  @Post('enrollments')
  @UseGuards(TenantGuard)
  @Roles(...MANAGE)
  @Audited('gateway.enrollment.created')
  @HttpCode(HttpStatus.CREATED)
  async createEnrollment(@Body() body: unknown) {
    const { label } = parseCreateEnrollment(body);
    return this.gateway.createEnrollment(label);
  }

  @Get('devices')
  @UseGuards(TenantGuard)
  @Roles(...MANAGE)
  async listDevices() {
    return { devices: await this.gateway.listDevices() };
  }

  @Post('pairings')
  @UseGuards(TenantGuard)
  @Roles(...MANAGE)
  @Audited('gateway.pairing.created')
  @HttpCode(HttpStatus.OK)
  async createPairing(@Body() body: unknown) {
    const { sourceId, deviceId } = parseCreatePairing(body);
    return this.gateway.createPairing(sourceId, deviceId);
  }

  @Post('devices/:id/revoke')
  @UseGuards(TenantGuard)
  @Roles(...MANAGE)
  @Audited('gateway.device.revoked')
  @HttpCode(HttpStatus.OK)
  async revokeDevice(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseRevokeReason(body);
    return this.gateway.revokeDevice(id, reason);
  }

  // --- device-facing -------------------------------------------------------

  @Post('enroll')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.device.enrolled')
  @HttpCode(HttpStatus.CREATED)
  async enroll(@Req() req: RequestWithGatewayEnrollment, @Body() body: unknown) {
    if (!req.gatewayEnrollmentId) throw new UnauthorizedException('A valid enrolment code is required.');
    return this.gateway.enroll(req.gatewayEnrollmentId, body);
  }

  @Post('heartbeat')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.device.heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    const deviceId = requireDevice(req);
    const { agentVersion } = parseHeartbeat(body);
    return this.gateway.heartbeat(deviceId, agentVersion);
  }

  @Post('pair/redeem')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.pairing.redeemed')
  @HttpCode(HttpStatus.OK)
  async redeemPairing(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    const deviceId = requireDevice(req);
    const { nonce, sourceId } = parseRedeemPairing(body);
    return this.gateway.redeemPairing(deviceId, nonce, sourceId);
  }

  @Post('session/refresh')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.session.refreshed')
  @HttpCode(HttpStatus.OK)
  async refreshSession(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    const deviceId = requireDevice(req);
    const { sessionToken } = parseRefreshSession(body);
    return this.gateway.refreshSession(deviceId, sessionToken);
  }

  @Post('deenroll')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('gateway.device.deenrolled')
  @HttpCode(HttpStatus.OK)
  async deenroll(@Req() req: RequestWithGatewayDevice) {
    return this.gateway.deenroll(requireDevice(req));
  }
}

function requireDevice(req: RequestWithGatewayDevice): string {
  if (!req.gatewayDeviceId) throw new UnauthorizedException('A valid device token is required.');
  return req.gatewayDeviceId;
}
