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
import { ConfigService } from '@nestjs/config';
import { PortalGuard } from '../../tenancy/portal.guard';
import type { RequestWithPortalTenant } from '../../tenancy/portal-tenant.middleware';
import { PublicPortal } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { RequestPortalService } from './request-portal.service';
import { verifyPortalToken } from './portal-token';
import { parseOtpCode, parsePortalMessage, parseSubmitRequest } from './dto';

/**
 * THE PUBLIC REQUEST PORTAL (FR-GRV-01/03) — the platform's only endpoints
 * reachable by someone with no account, no API key, and no identity.
 *
 * Every route here carries @PublicPortal() and PortalGuard, which together mean
 * something precise: the request was resolved by PortalTenantMiddleware from a
 * URL slug, it has a real tenant bound for RLS, and it has no actor. A staff JWT
 * cannot reach these handlers (PortalGuard rejects it) and neither can a request
 * for a slug that does not exist.
 *
 * AUDIT. These are the first mutating routes in the platform with no
 * authenticated actor, and they are audited exactly like every other mutation —
 * the S5 interceptor is global and does not know or care that this controller is
 * public. What changes is only the attribution: `actor_id` is NULL and
 * `actor_label` is `public_portal:anonymous`, so the log says "a member of the
 * public did this" rather than inventing someone who did.
 *
 * The tenant in the URL is NOT trusted as an authorisation: it selects which
 * tenant's portal this is, and the ticket id in the path is re-checked under
 * that tenant's RLS on every call, so a ticket id from one tenant is simply not
 * found under another's slug.
 */
@Controller('portal/:slug')
@UseGuards(PortalGuard)
export class RequestPortalController {
  private readonly jwtSecret: string;

  constructor(
    private readonly portal: RequestPortalService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.get<string>('JWT_SECRET') ?? '';
  }

  /** The public projection of a tenant: enough to render "you are filing a
   *  request with X", and nothing else the peephole could have leaked. */
  @Get()
  @PublicPortal()
  organisation(@Req() req: RequestWithPortalTenant) {
    return {
      slug: req.portalTenant!.slug,
      organisationName: req.portalTenant!.organisationName,
    };
  }

  @Post('requests')
  @PublicPortal()
  @Audited('request.submitted')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() body: unknown, @Req() req: RequestWithPortalTenant) {
    return this.portal.submit(parseSubmitRequest(body), {
      // Provenance for an unauthenticated intake. An IP is personal data and is
      // stored as evidence, under the same controls as the audit log's.
      sourceIp: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Post('requests/:ticketId/otp')
  @PublicPortal()
  @Audited('request.contact_verification.reissued')
  @HttpCode(HttpStatus.OK)
  async resendOtp(@Param('ticketId') ticketId: string) {
    return this.portal.resendOtp(ticketId);
  }

  @Post('requests/:ticketId/otp/verify')
  @PublicPortal()
  @Audited('request.contact_verified')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Param('ticketId') ticketId: string, @Body() body: unknown) {
    return this.portal.verifyContact(ticketId, parseOtpCode(body));
  }

  /**
   * From here on the requester needs the portal token their OTP round-trip
   * bought. A reference code alone is not enough to read a request — it is
   * quoted in emails and read out over the phone, and treating it as a bearer
   * secret is how one leaks a stranger's complaint.
   */
  @Get('requests/:ticketId')
  @PublicPortal()
  async view(@Param('ticketId') ticketId: string, @Req() req: RequestWithPortalTenant) {
    this.requirePortalToken(req, ticketId);
    return this.portal.portalView(ticketId);
  }

  @Post('requests/:ticketId/correspondence')
  @PublicPortal()
  @Audited('request.correspondence.added')
  @HttpCode(HttpStatus.CREATED)
  async reply(
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Req() req: RequestWithPortalTenant,
  ) {
    this.requirePortalToken(req, ticketId);
    return this.portal.addRequesterMessage(ticketId, parsePortalMessage(body));
  }

  /**
   * Verify the portal token names THIS ticket under THIS tenant.
   *
   * All three checks matter and none is redundant: the signature stops forgery,
   * the ticket claim stops a token for one request being used to read another,
   * and the tenant claim stops a token minted on one tenant's portal being
   * replayed against another's — which RLS would also catch, but a 401 at the
   * edge is the better answer than a confusing 404 from underneath.
   */
  private requirePortalToken(req: RequestWithPortalTenant, ticketId: string): void {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Verify your contact channel to view this request.');
    }
    let claims;
    try {
      claims = verifyPortalToken(header.slice('Bearer '.length), this.jwtSecret);
    } catch {
      throw new UnauthorizedException('That link has expired. Verify your contact channel again.');
    }
    if (claims.ticketId !== ticketId || claims.tenantId !== req.portalTenant!.tenantId) {
      throw new UnauthorizedException('That link does not belong to this request.');
    }
  }
}
