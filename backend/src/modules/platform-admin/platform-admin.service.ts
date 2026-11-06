import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../tenancy/jwt';
import { PASSWORD_HASHER, makeDummyHash, type PasswordHasher } from '../identity/crypto/password-hasher';
import { LicensingService, type LicenseView } from '../licensing/licensing.service';
import type { IssueLicenseInput } from '../licensing/licensing.dto';
import { PlatformAdminRepository, type OrganisationSummary } from './platform-admin.repository';
import { maskRecipient } from '../../logging/redact';

export interface PlatformAdminSession {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

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
  // 12h: long enough for one support session, short enough that a leaked
  // token (the single most powerful bearer credential on the platform) is
  // not a standing risk for days. Tighten via PLATFORM_ADMIN_TOKEN_TTL_SECONDS.
  private readonly tokenTtlSeconds: number;
  private dummyHash: Promise<string> | null = null;

  constructor(
    config: ConfigService,
    private readonly repo: PlatformAdminRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly licensing: LicensingService,
  ) {
    this.secret = config.get<string>('JWT_SECRET') ?? '';
    if (!this.secret) {
      throw new Error('JWT_SECRET is required — it signs the platform-admin token too.');
    }
    this.tokenTtlSeconds = Number(config.get('PLATFORM_ADMIN_TOKEN_TTL_SECONDS') ?? 12 * 60 * 60);
  }

  async login(email: string, password: string): Promise<PlatformAdminSession> {
    const resolution = await this.repo.resolveLogin(email);
    if (!resolution) {
      await this.burnTime(password);
      throw new UnauthorizedException('Invalid email or password.');
    }
    const ok = await this.hasher.verify(password, resolution.passwordHash);
    if (!ok) {
      // Masked: repeated attempts against one account still read as one
      // account, without the address itself going into the logs.
      this.logger.warn(`Failed platform-admin login attempt for ${maskRecipient(email)}`);
      throw new UnauthorizedException('Invalid email or password.');
    }
    await this.repo.touchLastLogin(resolution.id);
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
