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

/** What the portal middleware attaches once a slug resolves. */
export interface RequestWithPortalTenant extends Request {
  portalTenant?: { tenantId: string; slug: string; organisationName: string };
}

/**
 * Exported because TenantContextMiddleware must skip these paths — see the note
 * there. Two middlewares agreeing on one constant is the cheap way to keep that
 * agreement from silently breaking.
 */
export const PORTAL_PATH_PREFIX = '/portal/';

/** The request path, safe against Nest's '*'-mount rebasing of `req.path`. */
export function portalRequestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * The OUTER cap. Deliberately generous and deliberately dumb: it exists to keep
 * a flood from reaching Postgres at all, not to enforce the product's rules. The
 * meaningful limits (per contact channel, per ticket) live inside the handlers
 * where they can be audited — see RequestPortalService.
 */
const PORTAL_IP_CAP: RateLimitRule = { limit: 120, windowMs: 60_000 };

/**
 * The edge of the PUBLIC REQUEST PORTAL (FR-GRV-01) — a third sibling to
 * TenantContextMiddleware (bearer JWT) and PublicApiKeyMiddleware (SDK key),
 * applied after both in TenancyModule. For any path under `/portal/`, it reads
 * the tenant slug from the first path segment, resolves it through
 * `app.resolve_portal_slug`, and runs the rest of the request inside the SAME
 * AsyncLocalStorage context everything else uses — so RLS, the unit of work, and
 * the audit interceptor need no knowledge that this route is public.
 *
 * ---------------------------------------------------------------------------
 * THE SLUG IS AN IDENTIFIER. THE API KEY IS A CREDENTIAL. THEY ARE NOT THE SAME
 * PROBLEM, AND THIS FILE MUST NOT BLUR THEM.
 *
 * PublicApiKeyMiddleware answers "is this caller allowed to write to the consent
 * register?" — possession of the key IS the authorisation, which is why the key
 * is hashed at rest, shown once, and revocable.
 *
 * This middleware answers only "which tenant is this public page about?".
 * Presenting a valid slug authorises NOTHING. It gets you exactly what any
 * member of the public is meant to have: the ability to see who a Data
 * Fiduciary's Grievance Officer is, and to file a request that then has to
 * survive an OTP and a human identity check before anyone acts on it. Every
 * privileged operation downstream is gated on something else entirely — a portal
 * token minted only after an OTP round-trip, or a staff JWT.
 *
 * Consequences of that distinction, made structural rather than assumed:
 *   - The context is marked `anonymous`, so the audit interceptor writes
 *     actor_id = NULL rather than attributing the action to anyone.
 *   - `userId` is the nil UUID. It is not a user and cannot become one: it fails
 *     every `REFERENCES users (id)` in the schema, so code that tries to treat a
 *     public submitter as an actor breaks loudly instead of silently.
 *   - An unknown slug is a plain 404. There is no "invalid credential" answer to
 *     give, because nothing was presented as a credential.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class PortalTenantMiddleware implements NestMiddleware {
  private readonly rateLimiter = new FixedWindowRateLimiter();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
  ) {}

  async use(req: RequestWithPortalTenant, _res: Response, next: NextFunction): Promise<void> {
    // req.path is NOT safe here — Nest rebases it for '*'-mounted middleware, so
    // it can read as '/' regardless of the real path. (The same trap
    // PublicApiKeyMiddleware documents.)
    const requestPath = portalRequestPath(req);
    if (!requestPath.startsWith(PORTAL_PATH_PREFIX)) {
      next();
      return;
    }

    // Cheapest possible check first: refuse a flood before it costs a database
    // round trip. Not audited, on purpose — writing an audit entry per request
    // would turn the log itself into the amplification target. The limits that
    // ARE audited are the per-contact ones inside the handlers, which are the
    // ones that describe a person's behaviour rather than a socket's.
    const verdict = this.rateLimiter.hit('portal_ip', this.sourceIp(req), PORTAL_IP_CAP);
    if (!verdict.allowed) {
      next(
        new HttpException(
          `Too many requests. Retry in ${verdict.retryAfterSeconds}s.`,
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      return;
    }

    const slug = decodeURIComponent(requestPath.slice(PORTAL_PATH_PREFIX.length).split('/')[0] ?? '');
    if (!slug) {
      next();
      return;
    }

    let resolved: Awaited<ReturnType<TenantDatabaseService['resolvePortalSlug']>>;
    try {
      resolved = await this.db.resolvePortalSlug(slug);
    } catch (err) {
      next(err);
      return;
    }

    if (!resolved) {
      next(new NotFoundException('No request portal exists at this address.'));
      return;
    }

    req.portalTenant = {
      tenantId: resolved.tenantId,
      slug,
      organisationName: resolved.name,
    };

    const context: TenantContext = {
      tenantId: resolved.tenantId,
      // Not a user. See ANONYMOUS_TENANT_USER_ID and the header above.
      userId: ANONYMOUS_TENANT_USER_ID,
      // There is no human RBAC role behind a public submission. 'viewer' is
      // simply the value that satisfies `Role`; the routes carry @PublicPortal()
      // (never @AllowReadOnly) so nobody later reads this as a claim that the
      // route is read-only. See roles.decorator.ts.
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
