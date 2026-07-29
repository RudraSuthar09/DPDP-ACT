import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import type { RequestWithPortalTenant } from './portal-tenant.middleware';

/**
 * The counterpart to TenantGuard for the public request portal (FR-GRV-01).
 *
 * TenantGuard asks "is there a tenant?". This asks the sharper question: "was
 * this tenant established by the PORTAL edge?" — because a staff JWT also
 * produces a perfectly good tenant context, and a portal route that accepted one
 * would be a route where a logged-in user could act as an anonymous submitter,
 * or where portal-shaped logic silently ran with staff authority behind it.
 *
 * A route carrying @PublicPortal() therefore gets exactly one kind of caller,
 * and the marking cannot rot: if PortalTenantMiddleware did not resolve this
 * request, it never reaches the handler.
 *
 * 404, not 401 or 403. Nothing was presented and nothing was rejected — the
 * address simply is not a portal address, and that is all a stranger needs to be
 * told.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPortalTenant>();
    const ctx = this.tenantContext.get();

    if (!request.portalTenant || !ctx?.anonymous || ctx.tenantId !== request.portalTenant.tenantId) {
      throw new NotFoundException('No request portal exists at this address.');
    }
    return true;
  }
}
