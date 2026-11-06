import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { verifyPlatformAdminJwt, type PlatformAdminJwtClaims } from './jwt';

/** What the guard attaches once a platform_admin bearer token verifies. */
export interface RequestWithPlatformAdmin extends Request {
  platformAdmin?: PlatformAdminJwtClaims;
}

/**
 * Exported because TenantContextMiddleware must skip these paths — see the
 * note there. Two files agreeing on one constant is the cheap way to keep
 * that agreement from silently breaking (same pattern as PORTAL_PATH_PREFIX/
 * FORM_PATH_PREFIX).
 */
export const PLATFORM_ADMIN_PATH_PREFIX = '/platform-admin';

/** The request path, safe against Nest's '*'-mount rebasing of `req.path`. */
export function platformAdminRequestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * Route-level authentication for the platform-admin tool (`/admin/licenses`
 * on the frontend). Deliberately NOT TenantGuard: this credential belongs to
 * no tenant (see the platform-admin migration header) — it verifies a
 * `platform_admin` token on its own and attaches the claims to the request,
 * rather than establishing any ambient tenant context. Every handler behind
 * this guard takes the target tenant explicitly, from the route, never from
 * ambient state.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithPlatformAdmin>();
    const authorization = req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Platform admin token required.');
    }
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    try {
      req.platformAdmin = verifyPlatformAdminJwt(authorization.slice('Bearer '.length), secret);
    } catch {
      throw new UnauthorizedException('Invalid or expired platform admin token.');
    }
    return true;
  }
}
