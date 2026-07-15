import { CanActivate, Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/**
 * Route-level enforcement of Seam S1: reject any request that reached a protected
 * handler without a tenant context. Apply with `@UseGuards(TenantGuard)` on
 * controllers/handlers that must be tenant-scoped. (The database layer is the
 * final fail-closed backstop, but rejecting early gives a clean 401.)
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  canActivate(): boolean {
    if (!this.tenantContext.get()) {
      throw new UnauthorizedException('Tenant context required for this route (Seam S1).');
    }
    return true;
  }
}
