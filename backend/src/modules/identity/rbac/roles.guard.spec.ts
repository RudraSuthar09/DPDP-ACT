import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role, TenantContext } from '@dpdp/shared';
import { TenantContextService } from '../../../tenancy/tenant-context.service';
import { RolesGuard } from './roles.guard';
import { ALLOW_READ_ONLY_KEY, ROLES_KEY } from './roles.decorator';

/**
 * RBAC is a security control, so these tests are written the way an attacker
 * reads a guard: not "does it let the right people in" but "what gets through".
 */

interface Scenario {
  method?: string;
  role?: Role;
  requiredRoles?: Role[];
  allowReadOnly?: boolean;
}

function makeGuard({ method = 'GET', role, requiredRoles, allowReadOnly }: Scenario) {
  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === ROLES_KEY) return requiredRoles;
      if (key === ALLOW_READ_ONLY_KEY) return allowReadOnly;
      return undefined;
    },
  } as unknown as Reflector;

  const tenantContext = new TenantContextService();
  const guard = new RolesGuard(reflector, tenantContext);

  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;

  const ctx: TenantContext | undefined = role
    ? { tenantId: 'tenant-a', userId: 'user-1', role, correlationId: 'corr-1' }
    : undefined;

  // Run inside the ALS scope, exactly as the real middleware does.
  return () =>
    ctx ? tenantContext.run(ctx, () => guard.canActivate(context)) : guard.canActivate(context);
}

describe('RolesGuard — the read-only floor (FR-IDN-03: "Auditor (read-only)")', () => {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const safe = ['GET', 'HEAD', 'OPTIONS'];

  // The whole point: this holds on a handler with NO annotation at all, because
  // "read-only" has to be what you get when the author wasn't thinking about it.
  describe.each<Role>(['auditor', 'viewer'])('%s', (role) => {
    it.each(mutating)('is refused %s on an unannotated route', (method) => {
      expect(makeGuard({ method, role })).toThrow(ForbiddenException);
    });

    it.each(safe)('is allowed %s', (method) => {
      expect(makeGuard({ method, role })()).toBe(true);
    });

    it('is refused a mutation even where @Roles would otherwise permit it', () => {
      // Read-only beats an explicit grant: a role list naming the auditor is far
      // more likely to be an oversight than an intention to let them write.
      expect(makeGuard({ method: 'POST', role, requiredRoles: [role] })).toThrow(
        ForbiddenException,
      );
    });

    it('is allowed a mutation only where @AllowReadOnly says so explicitly', () => {
      expect(makeGuard({ method: 'POST', role, allowReadOnly: true })()).toBe(true);
    });

    it('is refused a lowercase-verb mutation (no case-based bypass)', () => {
      expect(makeGuard({ method: 'post', role })).toThrow(ForbiddenException);
    });
  });

  it.each<Role>(['owner', 'dpo', 'compliance_officer', 'grievance_officer'])(
    '%s may mutate',
    (role) => {
      expect(makeGuard({ method: 'POST', role })()).toBe(true);
    },
  );
});

describe('RolesGuard — @Roles enforcement', () => {
  it('allows a role on the list', () => {
    expect(makeGuard({ method: 'POST', role: 'dpo', requiredRoles: ['owner', 'dpo'] })()).toBe(
      true,
    );
  });

  it('refuses a role off the list', () => {
    expect(
      makeGuard({ method: 'POST', role: 'compliance_officer', requiredRoles: ['owner'] }),
    ).toThrow(ForbiddenException);
  });

  it('refuses an unauthenticated caller on a @Roles route with 401, not 403', () => {
    // No tenant context and the route names roles → it is not public, whatever
    // the guard order happens to be. 401 because the caller has no identity at
    // all — "who are you" is a different answer from "you may not". This guard
    // is global and runs before the controller-scoped TenantGuard, so it is what
    // decides the status code for a missing token on a @Roles route.
    expect(makeGuard({ method: 'POST', requiredRoles: ['owner'] })).toThrow(UnauthorizedException);
  });

  it('defers on an unannotated route with no tenant context (public: login, register)', () => {
    expect(makeGuard({ method: 'POST' })()).toBe(true);
  });

  it('names the required roles in the error, without leaking anything else', () => {
    expect(makeGuard({ method: 'POST', role: 'viewer', requiredRoles: ['owner'] })).toThrow(
      /read-only/,
    );
    expect(
      makeGuard({ method: 'POST', role: 'compliance_officer', requiredRoles: ['owner'] }),
    ).toThrow(/requires one of: owner/);
  });
});
