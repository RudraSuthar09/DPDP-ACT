import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Role, TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { verifyTenantJwt } from './jwt';

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
