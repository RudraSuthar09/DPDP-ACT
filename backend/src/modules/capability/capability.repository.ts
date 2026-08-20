import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The one read CapabilityService needs that isn't already owned by another
 * module's service: the tenant's descriptive org-level plan/deployment_type
 * (organisations.plan/deployment_type — visibility-only per its own migration
 * until this module gives it teeth). RLS-scoped, read-only, single query.
 */
@Injectable()
export class CapabilityRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  getOrganisationDefaults(): Promise<{ plan: 'saas' | 'enterprise'; deploymentType: 'hosted' | 'client_server' } | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ plan: 'saas' | 'enterprise'; deployment_type: 'hosted' | 'client_server' }>(
        `SELECT plan, deployment_type FROM organisations WHERE id = app.current_tenant()`,
      );
      const row = rows[0];
      return row ? { plan: row.plan, deploymentType: row.deployment_type } : null;
    });
  }
}
