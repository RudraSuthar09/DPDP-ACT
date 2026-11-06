import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface PlatformAdminLoginResolution {
  id: string;
  passwordHash: string;
  passwordAlgo: string;
}

export interface OrganisationSummary {
  id: string;
  name: string;
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  /** The account owner's email — org NAME alone doesn't disambiguate two
   *  clients that happen to share a display name; this does. Null only for
   *  the rare directory row whose owner-sync hasn't landed yet. */
  ownerEmail: string | null;
  createdAt: Date;
}

/**
 * Platform-admin data access. Everything here runs over `runUntenanted`
 * (no tenant bound, dpdp_app connection) and reaches the database only
 * through the SECURITY DEFINER peepholes the platform-admin migration
 * defines — app.resolve_platform_admin_login, app.touch_platform_admin_login,
 * app.list_organisations. There is no direct table access to
 * platform_admins from this (or any) role; see that migration's comments.
 */
@Injectable()
export class PlatformAdminRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  resolveLogin(email: string): Promise<PlatformAdminLoginResolution | null> {
    return this.db.runUntenanted(async (client) => {
      const { rows } = await client.query<{ id: string; password_hash: string; password_algo: string }>(
        'SELECT id, password_hash, password_algo FROM app.resolve_platform_admin_login($1)',
        [email],
      );
      const row = rows[0];
      return row ? { id: row.id, passwordHash: row.password_hash, passwordAlgo: row.password_algo } : null;
    });
  }

  touchLastLogin(id: string): Promise<void> {
    return this.db.runUntenanted(async (client) => {
      await client.query('SELECT app.touch_platform_admin_login($1)', [id]);
    });
  }

  listOrganisations(): Promise<OrganisationSummary[]> {
    return this.db.runUntenanted(async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        plan: 'saas' | 'enterprise';
        deployment_type: 'hosted' | 'client_server';
        owner_email: string | null;
        created_at: Date;
      }>('SELECT id, name, plan, deployment_type, owner_email, created_at FROM app.list_organisations()');
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        plan: r.plan,
        deploymentType: r.deployment_type,
        ownerEmail: r.owner_email,
        createdAt: r.created_at,
      }));
    });
  }
}
