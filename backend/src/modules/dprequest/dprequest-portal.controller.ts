import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { RequestWithPortalTenant } from '../../tenancy/portal-tenant.middleware';
import { PortalGuard } from '../../tenancy/portal.guard';
import { PublicPortal } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { parseSubmitRequest } from '../request/dto';
import { DPRequestService } from './dprequest.service';
import { asRecord, parseRightType } from './dto';

/**
 * The DPR-specific FRONT DOOR of the public portal (FR-DPR-01).
 *
 * A thin wrapper, exactly like `GrievancePortalController` — not a second
 * submission path. Creating the ticket, minting and sending the OTP, and
 * proving the contact channel are `RequestPortalService.submit`, the same code
 * the generic `POST /portal/:slug/requests` route runs. This route's only job
 * is to capture the two DPR-specific facts in the SAME request: which right is
 * being exercised, and (following from it) which versioned deadline record the
 * ticket will be judged under.
 *
 * OTP resend/verify and the requester's status view stay on the GENERIC routes.
 * The ticket id this route returns is the same id those take, and nothing about
 * proving a contact channel differs for a rights request.
 */
@Controller('portal/:slug/data-requests')
@UseGuards(PortalGuard)
export class DPRequestPortalController {
  constructor(private readonly dprequest: DPRequestService) {}

  @Post()
  @PublicPortal()
  @Audited('dprequest.submitted')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() body: unknown, @Req() req: RequestWithPortalTenant) {
    const raw = asRecord(body);
    const rightType = parseRightType(raw);
    // requestType is forced, never trusted from the body — this route IS the
    // rights-request door, and coercing rather than validating closes off
    // "POST a grievance through the DPR door" entirely.
    const submission = parseSubmitRequest({ ...raw, requestType: 'dprequest' });

    return this.dprequest.submit(rightType, submission, {
      sourceIp: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}
