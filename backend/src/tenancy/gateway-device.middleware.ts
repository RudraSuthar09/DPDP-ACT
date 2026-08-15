import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { verifyGatewayDeviceJwt } from './jwt';

/** The device id resolved from a verified gateway_device token, attached so the
 *  controller/service can act on the right device without re-parsing. */
export interface RequestWithGatewayDevice extends Request {
  gatewayDeviceId?: string;
}

/** The device-facing control-plane routes an enrolled Gateway calls with a
 *  `gateway_device` token (NOT /gateway/enroll — that uses the enrolment code). */
export const GATEWAY_DEVICE_PATHS = new Set([
  '/gateway/heartbeat',
  '/gateway/pair/redeem',
  '/gateway/session/refresh',
  '/gateway/deenroll',
]);

const DEVICE_TOKEN_HEADER = 'x-gateway-device-token';

export function gatewayRequestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * The Gateway device-token edge, sibling of PublicApiKeyMiddleware. For the
 * device-facing control routes it reads the `x-gateway-device-token` header, a
 * `gateway_device` JWT signed by the platform secret, verifies it, and runs the
 * rest of the request in the SAME AsyncLocalStorage tenant context the rest of
 * the app uses — so RLS and the audit interceptor need no changes.
 *
 * The token carries a verified tenant_id (→ the RLS GUC) and gw_actor (the
 * enrolling staff user, used as the audit actor — a device has no users(id) row).
 * Device REVOCATION is enforced later by an in-DB status check (fail closed); a
 * bearer JWT cannot itself be revoked before expiry. Every other path no-ops.
 */
@Injectable()
export class GatewayDeviceMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  use(req: RequestWithGatewayDevice, _res: Response, next: NextFunction): void {
    if (!GATEWAY_DEVICE_PATHS.has(gatewayRequestPath(req))) {
      next();
      return;
    }

    const raw = req.header(DEVICE_TOKEN_HEADER);
    if (!raw) {
      // No device token: proceed with no context; TenantGuard gives the 401.
      next();
      return;
    }

    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    let context: TenantContext;
    try {
      const claims = verifyGatewayDeviceJwt(raw.trim(), secret);
      req.gatewayDeviceId = claims.deviceId;
      context = {
        tenantId: claims.tenantId,
        // A device has no users row; the audit actor is the enrolling staff user.
        userId: claims.actorUserId,
        // 'viewer' satisfies the type; the device routes carry @AllowGatewayDevice
        // so the read-only floor does not reject their (mutating) calls.
        role: 'viewer',
        correlationId: req.header('x-correlation-id') ?? randomUUID(),
      };
    } catch {
      next(new UnauthorizedException('Invalid or expired device token'));
      return;
    }

    this.tenantContext.run(context, () => next());
  }
}
