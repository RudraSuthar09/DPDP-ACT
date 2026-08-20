import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { LicensingRepository, type LicenseRow } from './licensing.repository';
import { generateLicenseKey, hashLicenseKey } from './license-key';
import { evaluateLicenseForActivation } from './licensing-policy';
import type { IssueLicenseInput } from './licensing.dto';

export interface LicenseView {
  id: string;
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  installationId: string | null;
  licenseKeyPrefix: string;
  status: 'pending' | 'active' | 'expired' | 'revoked';
  features: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  activatedAt: string | null;
}

/**
 * Licensing: issue license keys, resolve+validate them at installation
 * registration, activate/revoke. Central and server-side authoritative — the
 * frontend never decides whether a license is valid (locked architecture §9).
 * Stores the license-key HASH only; the raw key is returned exactly once, at
 * issuance, and never persisted.
 */
@Injectable()
export class LicensingService {
  constructor(
    private readonly repo: LicensingRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async issue(input: IssueLicenseInput): Promise<{ license: LicenseView; licenseKey: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const { key, hash, prefix } = generateLicenseKey();
    const row = await this.repo.createLicense({
      plan: input.plan,
      deploymentType: input.deploymentType,
      licenseKeyHash: hash,
      licenseKeyPrefix: prefix,
      features: input.features,
      expiresAt: input.expiresAt,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'license',
      targetId: row.id,
      reason: `License issued (${row.plan}/${row.deployment_type}), prefix ${row.license_key_prefix}.`,
      afterState: { plan: row.plan, deploymentType: row.deployment_type, status: row.status },
    });
    // The raw key is returned exactly once and never stored.
    return { license: toView(row), licenseKey: key };
  }

  /**
   * The pre-authentication sibling of issue(): called from organisation
   * self-registration (FR-IDN-01), where there is no request tenant context
   * to read a caller from — the tenant id and the just-created Owner's id are
   * supplied explicitly instead, the same way UsersRepository.insertUser is
   * during that same flow. Otherwise identical to issue(): same key
   * generation, same hash-only persistence, same "raw key returned once"
   * discipline. Does NOT annotate the audit context itself — the caller
   * (LocalIdentityProvider) folds this into its own single registration-event
   * annotation, since one HTTP request produces exactly one audit row.
   */
  async issueForTenant(
    tenantId: string,
    createdBy: string,
    input: { plan: 'saas' | 'enterprise'; deploymentType: 'hosted' | 'client_server' },
  ): Promise<{ license: LicenseView; licenseKey: string }> {
    const { key, hash, prefix } = generateLicenseKey();
    const row = await this.repo.createLicenseForTenant(tenantId, {
      plan: input.plan,
      deploymentType: input.deploymentType,
      licenseKeyHash: hash,
      licenseKeyPrefix: prefix,
      features: {},
      expiresAt: null,
      createdBy,
    });
    return { license: toView(row), licenseKey: key };
  }

  async list(): Promise<LicenseView[]> {
    return (await this.repo.list()).map(toView);
  }

  /**
   * Resolve a presented license key and confirm it currently, actively
   * entitles the requested plan/deploymentType — the server-side enforcement
   * point behind installation registration (locked architecture §9/§12).
   * Never trusts the caller's own claim about what it's entitled to.
   */
  async resolveAndValidate(
    licenseKey: string,
    requested: { plan: 'saas' | 'enterprise'; deploymentType: 'hosted' | 'client_server' },
  ): Promise<LicenseRow> {
    const row = await this.repo.findByKeyHash(hashLicenseKey(licenseKey));
    const result = evaluateLicenseForActivation(row, requested, new Date());
    if (!result.ok) {
      if (!row) throw new NotFoundException('License key not recognised.');
      throw new ForbiddenException(`License validation failed: ${result.reason}.`);
    }
    return row!;
  }

  /** Bind a validated license to the installation it just activated. */
  async activate(licenseId: string, installationId: string): Promise<LicenseView> {
    const row = await this.repo.activate(licenseId, installationId);
    if (!row) {
      // Already active (e.g. re-registration) — return current state rather
      // than failing a request that resolveAndValidate already approved.
      const existing = await this.repo.list();
      const found = existing.find((l) => l.id === licenseId);
      if (!found) throw new NotFoundException('License not found.');
      return toView(found);
    }
    this.audit.annotate({
      targetType: 'license',
      targetId: row.id,
      reason: `License activated for installation ${installationId}.`,
      afterState: { status: row.status, installationId: row.installation_id },
    });
    return toView(row);
  }

  async revoke(licenseId: string, reason: string | null): Promise<LicenseView> {
    const ctx = this.tenantContext.getOrThrow();
    const row = await this.repo.revoke(licenseId, ctx.userId, reason);
    if (!row) throw new NotFoundException('License not found or already revoked.');
    this.audit.annotate({
      targetType: 'license',
      targetId: row.id,
      reason: reason ?? 'License revoked.',
      beforeState: { status: 'active' },
      afterState: { status: 'revoked' },
    });
    return toView(row);
  }

  /** The tenant's currently active license, or null (no license = unlicensed
   *  fallback; CapabilityService derives features from organisations.plan). */
  async findActiveForTenant(): Promise<LicenseRow | null> {
    return this.repo.findActiveForTenant();
  }
}

function toView(row: LicenseRow): LicenseView {
  return {
    id: row.id,
    plan: row.plan,
    deploymentType: row.deployment_type,
    installationId: row.installation_id,
    licenseKeyPrefix: row.license_key_prefix,
    status: row.status,
    features: row.features,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
  };
}
