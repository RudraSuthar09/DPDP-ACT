import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isReadOnlyRole, type Role } from '@dpdp/shared';
import { TenantContextService } from '../../../tenancy/tenant-context.service';
import {
  ALLOW_PUBLIC_KEY_KEY,
  ALLOW_READ_ONLY_KEY,
  PUBLIC_PORTAL_KEY,
  ROLES_KEY,
} from './roles.decorator';

/** HTTP methods that, by definition, do not change state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * RBAC enforcement (FR-IDN-03). Registered globally, and it does two jobs:
 *
 * 1. THE READ-ONLY FLOOR. Any authenticated request from a read-only role
 *    (Auditor, Viewer) that is not a safe HTTP method is refused — with no
 *    annotation on the handler at all. FR-IDN-03 says "Auditor (read-only)",
 *    and the only way to mean that is for read-only to be what a handler gets
 *    when its author was thinking about something else. Opting out is possible
 *    (@AllowReadOnly) but has to be deliberate and is greppable.
 *
 * 2. Per-route role lists, where a handler declares @Roles(...).
 *
 * Routes with no @Roles and no tenant context are public (registration, login,
 * health): the guard defers, and TenantGuard + the fail-closed database layer
 * are what stand behind any route that should not have been public.
 *
 * The role comes from the ALS tenant context — i.e. from a verified JWT claim,
 * the same verified claim that bound the Postgres session. It cannot come from
 * a header or a body, so it cannot be asserted by the caller.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const ctx = this.tenantContext.get();

    if (!ctx) {
      // Unauthenticated. If the route declared @Roles it is certainly not
      // public, so refuse rather than fall through to the handler.
      //
      // 401, not 403: the caller has no identity, which is a different answer
      // from "your identity is not allowed". It also keeps the API consistent —
      // this guard is global and runs BEFORE the controller-scoped TenantGuard,
      // so without this a @Roles route would answer 403 where an unannotated
      // one answers 401, for the identical missing-token cause.
      if (required?.length) {
        throw new UnauthorizedException('Authentication is required for this route.');
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const allowReadOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_READ_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Distinct from allowReadOnly: a route that DOES mutate, but is reached
    // via a public API key rather than a human role (see AllowPublicKey's doc
    // comment for why 'viewer' shows up here at all).
    const allowPublicKey = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_PUBLIC_KEY_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Distinct again: a public request-portal route (FR-GRV-01), reached with no
    // credential at all. Its context carries role 'viewer' for the same
    // type-satisfying reason — see PublicPortal's doc comment.
    const publicPortal = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_PORTAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (
      isReadOnlyRole(ctx.role) &&
      !SAFE_METHODS.has(request.method.toUpperCase()) &&
      !allowReadOnly &&
      !allowPublicKey &&
      !publicPortal
    ) {
      throw new ForbiddenException(`The ${ctx.role} role is read-only and cannot modify data.`);
    }

    if (required?.length && !required.includes(ctx.role)) {
      throw new ForbiddenException(
        `This action requires one of: ${required.join(', ')}. You are ${ctx.role}.`,
      );
    }

    return true;
  }
}
