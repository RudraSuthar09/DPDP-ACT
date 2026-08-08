import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  NestMiddleware,
  NotFoundException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ANONYMOUS_TENANT_USER_ID, type TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { TenantDatabaseService } from '../database/database.service';
import { FixedWindowRateLimiter, type RateLimitRule } from './fixed-window-rate-limiter';

/** What the form middleware attaches once a slug resolves. */
export interface RequestWithFormTenant extends Request {
  formTenant?: { tenantId: string; slug: string; formId: string; formTitle: string };
}

/** Exported for the same reason PORTAL_PATH_PREFIX is: TenantContextMiddleware
 *  must skip these paths too, and two files agreeing on one constant is the
 *  cheap way to keep that agreement from silently breaking. */
export const FORM_PATH_PREFIX = '/forms/';

/** The request path, safe against Nest's '*'-mount rebasing of `req.path` —
 *  same trap PortalTenantMiddleware and PublicApiKeyMiddleware document. */
export function formRequestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

const FORM_IP_CAP: RateLimitRule = { limit: 60, windowMs: 60_000 };

/**
 * The edge of the HOSTED CONSENT FORM LINK — a fourth sibling to
 * TenantContextMiddleware, PublicApiKeyMiddleware and PortalTenantMiddleware,
 * built to the exact same pattern as the last of those (see its header for the
 * full account of why a SLUG IS AN IDENTIFIER, NOT A CREDENTIAL — the same
 * reasoning applies here verbatim). Kept as its own file/table/function rather
 * than reusing PortalTenantMiddleware because a form slug resolves to a
 * (tenant, FORM) pair, not just a tenant — a different return shape, so a
 * different peephole, so no future edit can quietly blur "which tenant" with
 * "which tenant and which form".
 *
 * For any path under `/forms/`, it reads the slug from the first path segment,
 * resolves it through `app.resolve_consent_form_slug`, and runs the rest of the
 * request inside the same AsyncLocalStorage context everything else uses.
 */
@Injectable()
export class FormTenantMiddleware implements NestMiddleware {
  private readonly rateLimiter = new FixedWindowRateLimiter();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
  ) {}

  async use(req: RequestWithFormTenant, _res: Response, next: NextFunction): Promise<void> {
    const requestPath = formRequestPath(req);
    if (!requestPath.startsWith(FORM_PATH_PREFIX)) {
      next();
      return;
    }

    const verdict = this.rateLimiter.hit('form_ip', this.sourceIp(req), FORM_IP_CAP);
    if (!verdict.allowed) {
      next(
        new HttpException(
          `Too many requests. Retry in ${verdict.retryAfterSeconds}s.`,
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      return;
    }

    const slug = decodeURIComponent(requestPath.slice(FORM_PATH_PREFIX.length).split('/')[0] ?? '');
    if (!slug) {
      next();
      return;
    }

    let resolved: Awaited<ReturnType<TenantDatabaseService['resolveConsentFormSlug']>>;
    try {
      resolved = await this.db.resolveConsentFormSlug(slug);
    } catch (err) {
      next(err);
      return;
    }

    if (!resolved) {
      next(new NotFoundException('No consent form exists at this address.'));
      return;
    }

    req.formTenant = {
      tenantId: resolved.tenantId,
      slug,
      formId: resolved.formId,
      formTitle: resolved.title,
    };

    const context: TenantContext = {
      tenantId: resolved.tenantId,
      userId: ANONYMOUS_TENANT_USER_ID,
      role: 'viewer',
      correlationId: req.header('x-correlation-id') ?? randomUUID(),
      anonymous: true,
    };

    this.tenantContext.run(context, () => next());
  }

  private sourceIp(req: Request): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
