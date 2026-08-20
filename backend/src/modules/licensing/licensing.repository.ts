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
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const LICENSE_COLS =
  'id, tenant_id, plan, deployment_type, installation_id, license_key_prefix, status, features, ' +
  'issued_at, expires_at, activated_at, revoked_at, revoke_reason, created_by, created_at, updated_at';

async function insertLicenseRow(
  client: PoolClient,
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
  const { rows } = await client.query<LicenseRow>(
    `INSERT INTO licenses (plan, deployment_type, license_key_hash, license_key_prefix, features, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${LICENSE_COLS}`,
    [input.plan, input.deploymentType, input.licenseKeyHash, input.licenseKeyPrefix, JSON.stringify(input.features), input.expiresAt, input.createdBy],
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
    return this.db.withTenant((client) => insertLicenseRow(client, input));
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
    return this.db.withTenantId(tenantId, (client) => insertLicenseRow(client, input));
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
