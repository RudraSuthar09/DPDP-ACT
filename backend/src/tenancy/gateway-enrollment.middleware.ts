import { createHash, randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { TenantDatabaseService } from '../database/database.service';
import { gatewayRequestPath } from './gateway-device.middleware';

/** The enrolment id resolved from a valid enrolment code, attached for the
 *  controller/service to consume it. */
export interface RequestWithGatewayEnrollment extends Request {
  gatewayEnrollmentId?: string;
}

const ENROLL_PATH = '/gateway/enroll';
const ENROLL_CODE_HEADER = 'x-gateway-enrollment-code';

/**
 * The Gateway ENROLMENT edge, sibling of PublicApiKeyMiddleware. A device that is
 * not yet enrolled has no tenant context and no device token — it presents a
 * one-time enrolment code in `x-gateway-enrollment-code`. This resolves that code
 * to a tenant via the pre-tenant peephole (app.resolve_gateway_enrollment, the
 * SECURITY DEFINER function — same chicken-and-egg as login/API-key), checks it
 * is unused and unexpired, and runs enrolment in that tenant's context.
 *
 * The audit actor is the staff user who created the code (created_by) — the
 * device has no users(id) row. Every other path no-ops.
 */
@Injectable()
export class GatewayEnrollmentMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
  ) {}

  async use(req: RequestWithGatewayEnrollment, _res: Response, next: NextFunction): Promise<void> {
    if (gatewayRequestPath(req) !== ENROLL_PATH) {
      next();
      return;
    }

    const raw = req.header(ENROLL_CODE_HEADER);
    if (!raw) {
      next(); // No code: TenantGuard gives the 401.
      return;
    }

    let resolved;
    try {
      resolved = await this.db.resolveGatewayEnrollment(createHash('sha256').update(raw.trim()).digest('hex'));
    } catch (err) {
      next(err);
      return;
    }

    // Validity is checked here so an invalid/expired/used code never establishes
    // a context. The service re-checks under RLS too (defence in depth + race).
    if (!resolved || resolved.consumedAt || Date.now() > new Date(resolved.expiresAt).getTime()) {
      next(new UnauthorizedException('Invalid, used, or expired enrolment code'));
      return;
    }

    req.gatewayEnrollmentId = resolved.enrollmentId;
    const context: TenantContext = {
      tenantId: resolved.tenantId,
      userId: resolved.createdBy,
      role: 'viewer',
      correlationId: req.header('x-correlation-id') ?? randomUUID(),
    };
    this.tenantContext.run(context, () => next());
  }
}
