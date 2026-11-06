import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import type { RequestWithGatewayDevice } from '../../tenancy/gateway-device.middleware';
import { AllowGatewayDevice } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { SubmissionDeliveryService } from './submission-delivery.service';
import { parseClaimInput, parseFailDeliveryInput, requireUuidParam } from './submission-delivery.dto';

/**
 * Device-facing routes for the submission delivery queue — reached ONLY by an
 * enrolled Gateway/delivery agent presenting a `gateway_device` token (the
 * SAME device-enrollment mechanism as every other /gateway/* device route;
 * no new auth mechanism). Every call is tenant-scoped by the verified token
 * claim (GatewayDeviceMiddleware -> TenantContext -> RLS) — a device can
 * never see or claim another tenant's submissions.
 *
 * No raw payload is ever returned from `pending` — only claim() (one at a
 * time, atomically) hands over the decrypted field values/documents, over
 * this same authenticated HTTPS connection, never logged.
 */
@Controller('gateway/submissions')
export class SubmissionDeliveryController {
  constructor(private readonly delivery: SubmissionDeliveryService) {}

  @Get('pending')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  async listPending(@Req() req: RequestWithGatewayDevice) {
    requireDevice(req);
    return { submissions: await this.delivery.listPending() };
  }

  @Post('claim')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('delivery.submission.claimed')
  @HttpCode(HttpStatus.OK)
  async claim(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    const deviceId = requireDevice(req);
    return this.delivery.claim(deviceId, parseClaimInput(body));
  }

  @Post(':id/ack')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('delivery.submission.delivered')
  @HttpCode(HttpStatus.OK)
  async ack(@Req() req: RequestWithGatewayDevice, @Param('id') id: string) {
    const deviceId = requireDevice(req);
    const ok = await this.delivery.ack(requireUuidParam(id), deviceId);
    return { ok };
  }

  @Post(':id/fail')
  @UseGuards(TenantGuard)
  @AllowGatewayDevice()
  @Audited('delivery.submission.failed')
  @HttpCode(HttpStatus.OK)
  async fail(@Req() req: RequestWithGatewayDevice, @Param('id') id: string, @Body() body: unknown) {
    const deviceId = requireDevice(req);
    const { error } = parseFailDeliveryInput(body);
    const ok = await this.delivery.fail(requireUuidParam(id), deviceId, error);
    return { ok };
  }
}

function requireDevice(req: RequestWithGatewayDevice): string {
  if (!req.gatewayDeviceId) throw new UnauthorizedException('A valid device token is required.');
  return req.gatewayDeviceId;
}
