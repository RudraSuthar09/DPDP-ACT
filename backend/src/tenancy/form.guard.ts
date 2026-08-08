import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import type { RequestWithFormTenant } from './form-tenant.middleware';

/**
 * The form-hosted-link counterpart to PortalGuard — see that file's doc
 * comment for the full reasoning, which applies here without modification: a
 * route carrying @PublicForm() must have been resolved by FormTenantMiddleware,
 * never by a staff JWT, so a logged-in user can never act as an anonymous
 * form submitter and form-portal logic can never silently run with staff
 * authority behind it.
 */
@Injectable()
export class FormGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithFormTenant>();
    const ctx = this.tenantContext.get();

    if (!request.formTenant || !ctx?.anonymous || ctx.tenantId !== request.formTenant.tenantId) {
      throw new NotFoundException('No consent form exists at this address.');
    }
    return true;
  }
}
