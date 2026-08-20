import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The installation store. Metadata only — plan/deploymentType/version/status/
 * heartbeat + non-secret environment metadata. Same shape/discipline as
 * GatewayRepository/LicensingRepository.
 */

export interface InstallationRow {
  id: string;
  tenant_id: string;
  plan: 'saas' | 'enterprise';
  deployment_type: 'hosted' | 'client_server';
  version: string;
  status: 'active' | 'inactive' | 'decommissioned';
  environment_metadata: Record<string, unknown>;
  registered_at: Date;
  registered_by: string | null;
  last_heartbeat_at: Date | null;
  decommissioned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const INSTALLATION_COLS =
  'id, tenant_id, plan, deployment_type, version, status, environment_metadata, registered_at, ' +
  'registered_by, last_heartbeat_at, decommissioned_at, created_at, updated_at';

@Injectable()
export class InstallationRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(input: {
    plan: 'saas' | 'enterprise';
    deploymentType: 'hosted' | 'client_server';
    version: string;
    environmentMetadata: Record<string, unknown>;
    registeredBy: string;
  }): Promise<InstallationRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<InstallationRow>(
        `INSERT INTO installations (plan, deployment_type, version, environment_metadata, registered_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${INSTALLATION_COLS}`,
        [input.plan, input.deploymentType, input.version, JSON.stringify(input.environmentMetadata), input.registeredBy],
      );
      return rows[0]!;
    });
  }

  findById(id: string): Promise<InstallationRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<InstallationRow>(
        `SELECT ${INSTALLATION_COLS} FROM installations WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /** The tenant's most recently registered active installation, or null. */
  findActive(): Promise<InstallationRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<InstallationRow>(
        `SELECT ${INSTALLATION_COLS} FROM installations WHERE status = 'active' ORDER BY registered_at DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    });
  }

  touchHeartbeat(id: string, version: string): Promise<InstallationRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<InstallationRow>(
        `UPDATE installations
            SET last_heartbeat_at = now(), version = $2
          WHERE id = $1 AND status = 'active'
          RETURNING ${INSTALLATION_COLS}`,
        [id, version],
      );
      return rows[0] ?? null;
    });
  }
}
