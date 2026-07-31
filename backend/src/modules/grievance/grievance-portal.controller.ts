import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { RequestWithPortalTenant } from '../../tenancy/portal-tenant.middleware';
import { PortalGuard } from '../../tenancy/portal.guard';
import { PublicPortal } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { parseSubmitRequest } from '../request/dto';
import { GrievanceService } from './grievance.service';
import { asRecord, parseGrievanceCategory } from './dto';

/**
 * The grievance-specific FRONT DOOR of the public portal (FR-GRV-01/02/03).
 *
 * A thin wrapper, not a second submission path. Creating the ticket, minting
 * and sending the OTP, and proving the contact channel are all
 * `RequestPortalService.submit` — the exact code the generic
 * `POST /portal/:slug/requests` route runs, called here rather than
 * duplicated. This route's only job is to also capture the one
 * grievance-specific fact (the category) in the SAME request, so it lands in
 * the same transaction and the same audit entry as the ticket itself — see
 * `GrievanceService.submit`.
 *
 * OTP resend/verify and the requester's status view stay on the GENERIC
 * routes (`/portal/:slug/requests/:ticketId/otp[...]`, `.../requests/:ticketId`)
 * — the ticket id this route hands back is the same id those routes take, and
 * nothing about proving a contact channel differs for a complaint.
 */
@Controller('portal/:slug/grievances')
@UseGuards(PortalGuard)
export class GrievancePortalController {
  constructor(private readonly grievance: GrievanceService) {}

  @Post()
  @PublicPortal()
  @Audited('grievance.submitted')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() body: unknown, @Req() req: RequestWithPortalTenant) {
    const raw = asRecord(body);
    const category = parseGrievanceCategory(raw);
    // requestType is forced here, never trusted from the body — this route IS
    // the grievance-specific one, and coercing it rather than validating it
    // closes off "POST a dprequest through the grievance door" entirely.
    const submission = parseSubmitRequest({ ...raw, requestType: 'grievance' });

    return this.grievance.submit(category, submission, {
      sourceIp: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }
}
