import { HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { AuditEntry } from '@dpdp/shared';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../tenancy/jwt';
import { FixedWindowRateLimiter, type RateLimitRule } from '../../tenancy/fixed-window-rate-limiter';
import { PASSWORD_HASHER, makeDummyHash, type PasswordHasher } from '../identity/crypto/password-hasher';
import { AuditVerifierService } from '../audit/audit-verifier.service';
import { LicensingService, type LicenseView } from '../licensing/licensing.service';
import type { IssueLicenseInput } from '../licensing/licensing.dto';
import { PlatformAdminRepository, type OrganisationSummary, type PlatformAdminSummary } from './platform-admin.repository';
import { maskRecipient } from '../../logging/redact';

export interface PlatformAdminSession {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

/** A licence plus the organisation it belongs to (admin portal listing). */
export interface AdminLicenseView extends LicenseView {
  tenantId: string;
  organisationName: string;
  ownerEmail: string | null;
}

/** Sign-in attempts (successful or not) per source IP / per account, per 15 min. */
const LOGIN_IP_RULE: RateLimitRule = { limit: 20, windowMs: 15 * 60 * 1000 };
const LOGIN_EMAIL_RULE: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * Platform-admin authentication + the cross-tenant actions the tool exists
 * for (list client orgs, list/issue licenses for a chosen one). Deliberately
 * its own, simpler auth path — see the platform-admin migration header for
 * why this is a separate system from identity's TokenService/RBAC rather
 * than a role bolted onto it.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);
  private readonly secret: string;
  // 8h: one working session, short enough that a leaked token (the single
  // most powerful bearer credential on the platform) is not a standing risk.
  // Tighten via PLATFORM_ADMIN_TOKEN_TTL_SECONDS.
  private readonly tokenTtlSeconds: number;
  private dummyHash: Promise<string> | null = null;
  private readonly rateLimiter = new FixedWindowRateLimiter();

  constructor(
    config: ConfigService,
    private readonly repo: PlatformAdminRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly licensing: LicensingService,
    private readonly auditReader: AuditVerifierService,
  ) {
    this.secret = config.get<string>('JWT_SECRET') ?? '';
    if (!this.secret) {
      throw new Error('JWT_SECRET is required — it signs the platform-admin token too.');
    }
    this.tokenTtlSeconds = Number(config.get('PLATFORM_ADMIN_TOKEN_TTL_SECONDS') ?? 8 * 60 * 60);
  }

  async login(email: string, password: string, sourceIp = 'unknown'): Promise<PlatformAdminSession> {
    // Rate limit BEFORE any hashing or database work: per source IP and per
    // target account, counting every attempt. In-memory, one process — the
    // same Stage-1 limiter (and the same caveat) as the public portals.
    for (const [bucket, key, rule] of [
      ['platform_admin_login_ip', sourceIp, LOGIN_IP_RULE],
      ['platform_admin_login_email', email, LOGIN_EMAIL_RULE],
    ] as const) {
      const verdict = this.rateLimiter.hit(bucket, key, rule);
      if (!verdict.allowed) {
        this.logger.warn(
          `Platform-admin login rate-limited (${bucket === 'platform_admin_login_ip' ? 'source IP' : 'account'}) for ${maskRecipient(email)} from ${sourceIp}`,
        );
        throw new HttpException(
          `Too many sign-in attempts. Try again in ${Math.max(verdict.retryAfterSeconds, 1)} seconds.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const resolution = await this.repo.resolveLogin(email);
    if (!resolution) {
      await this.burnTime(password);
      this.logger.warn(`Failed platform-admin login attempt for ${maskRecipient(email)} from ${sourceIp} (unknown account)`);
      throw new UnauthorizedException('Invalid email or password.');
    }
    const ok = await this.hasher.verify(password, resolution.passwordHash);
    if (!ok) {
      // Masked: repeated attempts against one account still read as one
      // account, without the address itself going into the logs.
      this.logger.warn(`Failed platform-admin login attempt for ${maskRecipient(email)} from ${sourceIp}`);
      throw new UnauthorizedException('Invalid email or password.');
    }
    await this.repo.touchLastLogin(resolution.id);
    // Platform-admin sessions belong to no tenant, so they cannot go into a
    // tenant's hash chain; the application log is their record.
    this.logger.log(`Platform-admin login succeeded for admin ${resolution.id} (${maskRecipient(email)}) from ${sourceIp}`);
    const accessToken = jwt.sign({ email, typ: 'platform_admin' }, this.secret, {
      subject: resolution.id,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: 'HS256',
      expiresIn: this.tokenTtlSeconds,
    });
    return { accessToken, expiresIn: this.tokenTtlSeconds, tokenType: 'Bearer' };
  }

  listOrganisations(): Promise<OrganisationSummary[]> {
    return this.repo.listOrganisations();
  }

  listLicenses(tenantId: string): Promise<LicenseView[]> {
    return this.licensing.listForTenant(tenantId);
  }

  /**
   * Every licence of every organisation, for the admin portal's overview and
   * licence list. Each organisation is read through LicensingService's
   * existing per-tenant method (its own RLS-bound transaction) — never one
   * query across tenants. Sequential on purpose: one pooled connection at a
   * time, however many organisations there are.
   */
  async listAllLicenses(): Promise<AdminLicenseView[]> {
    const orgs = await this.repo.listOrganisations();
    const out: AdminLicenseView[] = [];
    for (const org of orgs) {
      const licenses = await this.licensing.listForTenant(org.id);
      for (const l of licenses) {
        out.push({ ...l, tenantId: org.id, organisationName: org.name, ownerEmail: org.ownerEmail });
      }
    }
    out.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return out;
  }

  rejectLicense(tenantId: string, licenseId: string, platformAdminEmail: string, reason: string): Promise<{ license: LicenseView }> {
    return this.licensing
      .rejectForPlatformAdmin(tenantId, licenseId, platformAdminEmail, reason)
      .then((license) => ({ license }));
  }

  /** One organisation's licensing audit entries (read-only, that tenant's RLS). */
  listLicensingAudit(tenantId: string, limit: number): Promise<AuditEntry[]> {
    return this.auditReader.listLicensingForTenant(tenantId, limit);
  }

  listAdmins(): Promise<PlatformAdminSummary[]> {
    return this.repo.listAdmins();
  }

  issueLicense(
    tenantId: string,
    platformAdminId: string,
    platformAdminEmail: string,
    input: IssueLicenseInput,
  ): Promise<{ license: LicenseView; licenseKey: string }> {
    return this.licensing.issueForPlatformAdmin(tenantId, platformAdminId, platformAdminEmail, input);
  }

  approveLicense(
    tenantId: string,
    licenseId: string,
    platformAdminId: string,
    platformAdminEmail: string,
  ): Promise<{ license: LicenseView }> {
    return this.licensing
      .approveForPlatformAdmin(tenantId, licenseId, platformAdminId, platformAdminEmail)
      .then((license) => ({ license }));
  }

  /** Verify against a throwaway hash purely to spend the same time a real
   *  check would — same reasoning as LocalIdentityProvider.burnTime. */
  private async burnTime(password: string): Promise<void> {
    this.dummyHash ??= makeDummyHash(this.hasher);
    await this.hasher.verify(password, await this.dummyHash);
  }
}
