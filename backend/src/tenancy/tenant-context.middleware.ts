import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Role, TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { verifyTenantJwt } from './jwt';
import { PORTAL_PATH_PREFIX, portalRequestPath } from './portal-tenant.middleware';
import { FORM_PATH_PREFIX, formRequestPath } from './form-tenant.middleware';

/**
 * The edge of Seam S1. For every request it:
 *   1. establishes a correlation id (from a header or fresh),
 *   2. verifies the bearer JWT and reads its `tenant_id` claim, and
 *   3. runs the rest of the request inside AsyncLocalStorage with that context.
 *
 * If there is no token, the request proceeds WITHOUT a tenant context: public
 * routes (health, sign-up, the grievance portal) are reachable, while protected
 * routes are rejected by TenantGuard and any tenant-scoped DB access fails closed
 * on its own. If a token is present but invalid, we reject with 401 — we never
 * fall back to an unverified tenant.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // The public request portal (FR-GRV-01) is the one place a Bearer token must
    // NOT be read as a session, for two independent reasons:
    //
    //   1. The bearer token there is a PORTAL token (typ='portal'), minted after
    //      an OTP round-trip and scoped to one ticket. verifyTenantJwt demands
    //      typ='access', so without this skip every authenticated portal read
    //      would 401 — the token would be rejected by the middleware before the
    //      controller that knows how to check it ever ran.
    //   2. More importantly, a STAFF access token must not establish tenant
    //      context on a portal route either. PortalGuard already refuses a
    //      request the portal edge did not resolve; skipping here means such a
    //      request cannot even acquire a context to be refused with, so "portal
    //      routes are reachable by exactly one kind of caller" is true of the
    //      middleware chain and not only of the guard.
    if (portalRequestPath(req).startsWith(PORTAL_PATH_PREFIX)) {
      next();
      return;
    }
    // Same reasoning as the portal skip above, for the hosted consent-form
    // link: a staff access token must not establish tenant context on a route
    // FormGuard expects FormTenantMiddleware alone to have resolved.
    if (formRequestPath(req).startsWith(FORM_PATH_PREFIX)) {
      next();
      return;
    }

    const correlationId = req.header('x-correlation-id') ?? randomUUID();
    const authorization = req.header('authorization');

    if (!authorization?.startsWith('Bearer ')) {
      next();
      return;
    }

    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    let context: TenantContext;
    try {
      const claims = verifyTenantJwt(authorization.slice('Bearer '.length), secret);
      context = {
        tenantId: claims.tenant_id,
        userId: claims.sub,
        role: (claims.role as Role | undefined) ?? 'viewer',
        correlationId,
      };
    } catch {
      next(new UnauthorizedException('Invalid or expired token'));
      return;
    }

    this.tenantContext.run(context, () => next());
  }
}
