import { createHash, randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';
import { TenantDatabaseService } from '../database/database.service';
import { FixedWindowRateLimiter, type RateLimitRule } from './fixed-window-rate-limiter';

/** Attached to the request once a key resolves, so the consent-public
 * controller can label the audit entry without re-deriving anything. */
export interface RequestWithConsentApiKey extends Request {
  consentApiKeyId?: string;
}

const API_KEY_RATE_LIMIT: RateLimitRule = { limit: 120, windowMs: 60_000 };
const PUBLIC_PATH_PREFIX = '/consent/public/';

/**
 * The edge of the Consent SDK's public credential path (FR-CON-09), sibling to
 * TenantContextMiddleware and applied right after it in TenancyModule. For
 * every request whose path starts with `/consent/public/`, it:
 *   1. reads the `X-Consent-Api-Key` header,
 *   2. resolves it to a tenant via TenantDatabaseService.resolveConsentApiKey
 *      (the SECURITY DEFINER peephole — see app.resolve_public_api_key), and
 *   3. runs the rest of the request inside the SAME AsyncLocalStorage context
 *      TenantContextMiddleware uses, so RLS and the audit interceptor need no
 *      changes at all downstream.
 *
 * Every other path is untouched — this middleware no-ops immediately.
 *
 * Deliberately NOT folded into TenantContextMiddleware: that file is the
 * generic Seam-S1 edge for every route in the app, and this is one feature's
 * narrow credential. Keeping it separate, but registered in the same place
 * (TenancyModule.configure) in an explicit order, is the cheaper way to keep
 * "what establishes tenant context, and in what order" reviewable in one spot
 * without coupling the generic middleware to one module's path prefix.
 *
 * Rate limiting: a fixed-window, in-memory counter per key id, via the shared
 * FixedWindowRateLimiter — the same limiter the public request portal
 * (PortalTenantMiddleware, FR-GRV-01) uses, so the platform's two
 * unauthenticated surfaces cannot drift apart. Its doc comment carries the full
 * account of what this Stage-1 stand-in does and does not guarantee (in short:
 * one process's memory, so it resets on restart and multiplies across
 * instances).
 */
@Injectable()
export class PublicApiKeyMiddleware implements NestMiddleware {
  private readonly rateLimiter = new FixedWindowRateLimiter();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
  ) {}

  async use(req: RequestWithConsentApiKey, _res: Response, next: NextFunction): Promise<void> {
    // req.path is NOT safe here: Nest mounts '*' middleware in a way that
    // rebases it relative to the match, so it can read as '/' regardless of
    // the real request path. originalUrl is untouched by that rebasing.
    const requestPath = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    if (!requestPath.startsWith(PUBLIC_PATH_PREFIX)) {
      next();
      return;
    }

    const correlationId = req.header('x-correlation-id') ?? randomUUID();
    const rawKey = req.header('x-consent-api-key');

    if (!rawKey) {
      // No key at all: proceed with no tenant context, exactly like
      // TenantContextMiddleware without a bearer token. TenantGuard gives the
      // standard 401 for this route rather than a second, differently-worded one.
      next();
      return;
    }

    const keyHash = createHash('sha256').update(rawKey.trim()).digest('hex');
    let resolved: Awaited<ReturnType<TenantDatabaseService['resolveConsentApiKey']>>;
    try {
      resolved = await this.db.resolveConsentApiKey(keyHash);
    } catch (err) {
      next(err);
      return;
    }

    if (!resolved || resolved.revokedAt) {
      next(new UnauthorizedException('Invalid or revoked API key'));
      return;
    }

    if (!this.rateLimiter.hit('consent_api_key', resolved.keyId, API_KEY_RATE_LIMIT).allowed) {
      next(new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS));
      return;
    }

    req.consentApiKeyId = resolved.keyId;

    // role: 'viewer' is not a claim about read-only access — it is the value
    // that satisfies TenantContext.role for a request with no human RBAC role
    // to report. The two routes this reaches use @AllowPublicKey(), not
    // @AllowReadOnly(), specifically so that isn't misread later. See that
    // decorator's doc comment (roles.decorator.ts) for the full reasoning.
    //
    // userId: createdBy, not the key's own id — the audit table's actor
    // column has a REFERENCES users(id) FK, and there is no user row for a key.
    const context: TenantContext = {
      tenantId: resolved.tenantId,
      userId: resolved.createdBy,
      role: 'viewer',
      correlationId,
    };

    this.tenantContext.run(context, () => next());
  }
}
