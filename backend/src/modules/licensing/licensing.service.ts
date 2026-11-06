import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { SystemAuditService } from '../audit/system-audit.service';
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
  /** 'platform_admin' when issued from the cross-tenant /admin/licenses
   *  support tool rather than by a tenant owner/dpo. */
  issuedBy: 'tenant_owner' | 'platform_admin';
  /** Platform-admin approval gate — null until approved; cannot activate an
   *  installation until then (see licensing-policy.ts). */
  approvedAt: string | null;
}

/**
 * Licensing: issue license keys, resolve+validate them at installation
 * registration, activate/revoke. Central and server-side authoritative — the
 * frontend never decides whether a license is valid (locked architecture §9).
 * Stores the license-key HASH only; the raw key is returned exactly once, at
 * issuance, and never persisted.
 */

/**
 * No per-plan entitlement-duration policy exists yet (that's a pricing/plans
 * decision, not an engineering one) — until it does, every license not given
 * an explicit `expiresAt` gets a flat 6-month validity window from issuance.
 * Revisit this the moment plan-based terms are defined; this is a placeholder,
 * not a policy.
 */
const DEFAULT_LICENSE_VALIDITY_MONTHS = 6;

function defaultExpiry(explicit: Date | null, issuedAt: Date): Date | null {
  if (explicit) return explicit;
  const d = new Date(issuedAt);
  d.setMonth(d.getMonth() + DEFAULT_LICENSE_VALIDITY_MONTHS);
  return d;
}

@Injectable()
export class LicensingService {
  constructor(
    private readonly repo: LicensingRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    private readonly systemAudit: SystemAuditService,
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
      expiresAt: defaultExpiry(input.expiresAt, new Date()),
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
      expiresAt: defaultExpiry(null, new Date()),
      createdBy,
    });
    return { license: toView(row), licenseKey: key };
  }

  async list(): Promise<LicenseView[]> {
    return (await this.repo.list()).map(toView);
  }

  /**
   * The platform-admin sibling of issueForTenant(): same key generation, same
   * hash-only persistence, attributed to a platform_admins row instead of a
   * users row (see createLicenseForTenantByPlatformAdmin). Used only by the
   * cross-tenant /admin/licenses support tool, never by any tenant-facing
   * route — PlatformAdminGuard is what makes that true.
   *
   * Records its own evidence via SystemAuditService rather than the global
   * interceptor: platform-admin requests carry no ambient tenant context for
   * the interceptor to record against (its @NoAudit route — see
   * PlatformAdminController), so without this the license would be issued
   * with no trace in the target tenant's own chain at all.
   */
  async issueForPlatformAdmin(
    tenantId: string,
    platformAdminId: string,
    platformAdminEmail: string,
    input: IssueLicenseInput,
  ): Promise<{ license: LicenseView; licenseKey: string }> {
    const { key, hash, prefix } = generateLicenseKey();
    const row = await this.repo.createLicenseForTenantByPlatformAdmin(
      tenantId,
      {
        plan: input.plan,
        deploymentType: input.deploymentType,
        licenseKeyHash: hash,
        licenseKeyPrefix: prefix,
        features: input.features,
        expiresAt: defaultExpiry(input.expiresAt, new Date()),
      },
      platformAdminId,
      (client, issued) =>
        this.systemAudit
          .record(client, tenantId, {
            action: 'licensing.license.issued_by_platform_admin',
            outcome: 'success',
            correlationId: randomUUID(),
            actorLabel: `platform-admin:${platformAdminEmail}`,
            targetType: 'license',
            targetId: issued.id,
            reason: `License issued by platform admin ${platformAdminEmail} (${issued.plan}/${issued.deployment_type}).`,
            afterState: { plan: issued.plan, deploymentType: issued.deployment_type, status: issued.status },
          })
          .then(() => undefined),
    );
    return { license: toView(row), licenseKey: key };
  }

  /** The platform-admin sibling of list(): explicit tenant, no ambient
   *  request-tenant context to read (see LicensingRepository.listForTenant). */
  async listForTenant(tenantId: string): Promise<LicenseView[]> {
    return (await this.repo.listForTenant(tenantId)).map(toView);
  }

  /**
   * The platform-admin approval gate itself (see licensing-policy.ts's
   * evaluateLicenseForActivation and the license-platform-admin-approval
   * migration): a license — however it was issued — cannot activate an
   * installation until this runs. Same audit discipline as
   * issueForPlatformAdmin: no ambient tenant context for the interceptor to
   * record against, so SystemAuditService lands the evidence directly in the
   * target tenant's own chain instead.
   */
  async approveForPlatformAdmin(
    tenantId: string,
    licenseId: string,
    platformAdminId: string,
    platformAdminEmail: string,
  ): Promise<LicenseView> {
    const row = await this.repo.approveForTenant(tenantId, licenseId, platformAdminId, (client, approved) =>
      this.systemAudit
        .record(client, tenantId, {
          action: 'licensing.license.approved_by_platform_admin',
          outcome: 'success',
          correlationId: randomUUID(),
          actorLabel: `platform-admin:${platformAdminEmail}`,
          targetType: 'license',
          targetId: approved.id,
          reason: `License approved by platform admin ${platformAdminEmail} (${approved.plan}/${approved.deployment_type}).`,
          afterState: { approvedAt: approved.approved_at?.toISOString() ?? null },
        })
        .then(() => undefined),
    );
    if (!row) throw new NotFoundException('License not found, or already approved.');
    return toView(row);
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

  /**
   * Bind a validated license to the installation it just activated.
   *
   * `licenses_one_active_per_tenant` (DB-enforced) means a tenant can only
   * ever have ONE active license — the exact scenario a lost-key reissue
   * hits: the client's OLD license is still `active` from a previous
   * install, a platform admin issues + approves a NEW one, and activating it
   * here would otherwise collide with the old row and surface as a raw
   * Postgres duplicate-key error (caught live). Superseding the old license
   * first is the correct behaviour, not a workaround: a fresh activation
   * means the old key is no longer the client's live entitlement, same as
   * reactivating desktop software with a new license supersedes the old one.
   */
  async activate(licenseId: string, installationId: string): Promise<LicenseView> {
    const ctx = this.tenantContext.getOrThrow();
    const currentlyActive = await this.repo.findActiveForTenant();
    if (currentlyActive && currentlyActive.id !== licenseId) {
      await this.repo.revoke(currentlyActive.id, ctx.userId, `Superseded by license ${licenseId} activating a new installation.`);
    }

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
      reason: currentlyActive
        ? `License activated for installation ${installationId} (superseded previously active license ${currentlyActive.id}).`
        : `License activated for installation ${installationId}.`,
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
    issuedBy: row.created_by_platform_admin ? 'platform_admin' : 'tenant_owner',
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
  };
}
