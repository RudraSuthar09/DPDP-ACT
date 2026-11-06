import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The licensing store. Reads/writes entitlement METADATA + the license-key
 * HASH only — never the raw key, never a customer value (I1). Same shape/
 * discipline as GatewayRepository.
 */

export interface LicenseRow {
  id: string;
  tenant_id: string;
  plan: 'saas' | 'enterprise';
  deployment_type: 'hosted' | 'client_server';
  installation_id: string | null;
  license_key_prefix: string;
  status: 'pending' | 'active' | 'expired' | 'revoked';
  features: Record<string, unknown>;
  issued_at: Date;
  expires_at: Date | null;
  activated_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_by: string | null;
  /** Set instead of created_by when issued via the cross-tenant /admin/licenses
   *  support tool — see the platform-admin migration. Exactly one of the two
   *  is ever set. */
  created_by_platform_admin: string | null;
  /** Platform-admin approval gate — see the license-platform-admin-approval
   *  migration. NULL until a platform admin approves this license. */
  approved_at: Date | null;
  approved_by_platform_admin: string | null;
  created_at: Date;
  updated_at: Date;
}

const LICENSE_COLS =
  'id, tenant_id, plan, deployment_type, installation_id, license_key_prefix, status, features, ' +
  'issued_at, expires_at, activated_at, revoked_at, revoke_reason, created_by, created_by_platform_admin, ' +
  'approved_at, approved_by_platform_admin, created_at, updated_at';

interface InsertLicenseInput {
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  licenseKeyHash: string;
  licenseKeyPrefix: string;
  features: Record<string, unknown>;
  expiresAt: Date | null;
  createdBy: string | null;
  createdByPlatformAdmin: string | null;
}

async function insertLicenseRow(client: PoolClient, input: InsertLicenseInput): Promise<LicenseRow> {
  const { rows } = await client.query<LicenseRow>(
    `INSERT INTO licenses (plan, deployment_type, license_key_hash, license_key_prefix, features, expires_at, created_by, created_by_platform_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${LICENSE_COLS}`,
    [
      input.plan,
      input.deploymentType,
      input.licenseKeyHash,
      input.licenseKeyPrefix,
      JSON.stringify(input.features),
      input.expiresAt,
      input.createdBy,
      input.createdByPlatformAdmin,
    ],
  );
  return rows[0]!;
}

@Injectable()
export class LicensingRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  createLicense(input: {
    plan: 'saas' | 'enterprise';
    deploymentType: 'hosted' | 'client_server';
    licenseKeyHash: string;
    licenseKeyPrefix: string;
    features: Record<string, unknown>;
    expiresAt: Date | null;
    createdBy: string;
  }): Promise<LicenseRow> {
    return this.db.withTenant((client) =>
      insertLicenseRow(client, { ...input, createdBy: input.createdBy, createdByPlatformAdmin: null }),
    );
  }

  /**
   * The pre-authentication sibling of createLicense: called from organisation
   * self-registration (FR-IDN-01), where there is no request tenant context
   * yet — same reasoning as UsersRepository.insertOrganisation/insertUser,
   * which take an explicit tenantId/client for the same reason. Shares the
   * exact same INSERT (insertLicenseRow) — not a second implementation, just
   * a different tenant-binding entry point (withTenantId vs withTenant),
   * mirroring TenantDatabaseService's own two entry points.
   */
  createLicenseForTenant(
    tenantId: string,
    input: {
      plan: 'saas' | 'enterprise';
      deploymentType: 'hosted' | 'client_server';
      licenseKeyHash: string;
      licenseKeyPrefix: string;
      features: Record<string, unknown>;
      expiresAt: Date | null;
      createdBy: string;
    },
  ): Promise<LicenseRow> {
    return this.db.withTenantId(tenantId, (client) =>
      insertLicenseRow(client, { ...input, createdBy: input.createdBy, createdByPlatformAdmin: null }),
    );
  }

  /**
   * The platform-admin sibling of createLicenseForTenant: same INSERT, but
   * attributed to a platform_admins row instead of a users row (see the
   * platform-admin migration's reasoning on licenses.created_by_platform_admin —
   * a support action must never be recorded as if a tenant employee did it).
   *
   * `recordAudit` runs on the SAME client as the insert, in the SAME
   * transaction — the platform-admin route has no ambient tenant context for
   * the global AuditInterceptor to record against (see PlatformAdminController's
   * @NoAudit routes), so this is how the license issuance still lands real
   * evidence in the target tenant's own chain, via SystemAuditService (the
   * sanctioned non-interceptor writer — see its header).
   */
  createLicenseForTenantByPlatformAdmin(
    tenantId: string,
    input: {
      plan: 'saas' | 'enterprise';
      deploymentType: 'hosted' | 'client_server';
      licenseKeyHash: string;
      licenseKeyPrefix: string;
      features: Record<string, unknown>;
      expiresAt: Date | null;
    },
    platformAdminId: string,
    recordAudit: (client: PoolClient, row: LicenseRow) => Promise<void>,
  ): Promise<LicenseRow> {
    return this.db.withTenantId(tenantId, async (client) => {
      const row = await insertLicenseRow(client, { ...input, createdBy: null, createdByPlatformAdmin: platformAdminId });
      await recordAudit(client, row);
      return row;
    });
  }

  /** The platform-admin sibling of list(): same SELECT, explicit tenant
   *  instead of the ambient request tenant — there is no request tenant on
   *  the platform-admin tool's token (see PlatformAdminGuard). */
  listForTenant(tenantId: string): Promise<LicenseRow[]> {
    return this.db.withTenantId(tenantId, async (client) => {
      const { rows } = await client.query<LicenseRow>(`SELECT ${LICENSE_COLS} FROM licenses ORDER BY created_at DESC`);
      return rows;
    });
  }

  /**
   * Looked up under the CALLER'S OWN tenant context (RLS-scoped) — a staff
   * member activating an installation can only ever resolve a license issued
   * to their own tenant. No pre-tenant peephole needed (see migration header).
   */
  findByKeyHash(licenseKeyHash: string): Promise<LicenseRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `SELECT ${LICENSE_COLS} FROM licenses WHERE license_key_hash = $1`,
        [licenseKeyHash],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * The tenant's effectively-usable active license: status = 'active' AND not
   * past its expires_at. A license past expiry stays status = 'active' in
   * storage (no sweeper flips it -- see the migration comment on this table)
   * but must stop being treated as usable the moment it expires, everywhere
   * this is the resolution point for (today: CapabilityService.resolve(), the
   * one enforcement primitive every capability/license check goes through).
   */
  findActiveForTenant(): Promise<LicenseRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `SELECT ${LICENSE_COLS} FROM licenses
          WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
          ORDER BY activated_at DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    });
  }

  list(): Promise<LicenseRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LicenseRow>(`SELECT ${LICENSE_COLS} FROM licenses ORDER BY created_at DESC`);
      return rows;
    });
  }

  /** Activate a pending license against a just-registered installation. */
  activate(id: string, installationId: string): Promise<LicenseRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `UPDATE licenses
            SET status = 'active', installation_id = $2, activated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING ${LICENSE_COLS}`,
        [id, installationId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * The platform-admin approval gate itself: a license cannot activate an
   * installation until this runs (see evaluateLicenseForActivation). Explicit
   * tenant (not withTenant) for the same reason as listForTenant/
   * createLicenseForTenantByPlatformAdmin — the platform-admin tool has no
   * ambient request tenant. `recordAudit` mirrors
   * createLicenseForTenantByPlatformAdmin: same client, same transaction, so
   * the approval lands real evidence in the target tenant's own chain.
   */
  approveForTenant(
    tenantId: string,
    licenseId: string,
    platformAdminId: string,
    recordAudit: (client: PoolClient, row: LicenseRow) => Promise<void>,
  ): Promise<LicenseRow | null> {
    return this.db.withTenantId(tenantId, async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `UPDATE licenses
            SET approved_at = now(), approved_by_platform_admin = $2
          WHERE id = $1 AND approved_at IS NULL
          RETURNING ${LICENSE_COLS}`,
        [licenseId, platformAdminId],
      );
      const row = rows[0];
      if (row) await recordAudit(client, row);
      return row ?? null;
    });
  }

  revoke(id: string, actorId: string, reason: string | null): Promise<LicenseRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `UPDATE licenses
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1 AND status IN ('pending', 'active')
          RETURNING ${LICENSE_COLS}`,
        [id, actorId, reason],
      );
      return rows[0] ?? null;
    });
  }
}
