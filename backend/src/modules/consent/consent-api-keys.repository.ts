import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface ConsentApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

const RETURNING = 'id, label, key_prefix, created_at, revoked_at';

/**
 * FR-CON-09: ordinary tenant-scoped CRUD over consent_api_keys — the staff
 * management side. Runs through the request's unit of work (withTenant), not
 * withTenantIdDetached, so creation/revocation commit atomically with their
 * @Audited entry exactly like every other tenant mutation in this codebase.
 * This is deliberately NOT where the SDK's own requests resolve a key — that
 * pre-tenant lookup is TenantDatabaseService.resolveConsentApiKey, a
 * SECURITY DEFINER peephole outside RLS entirely (see the migration).
 */
@Injectable()
export class ConsentApiKeysRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(input: {
    keyHash: string;
    keyPrefix: string;
    label: string;
    createdBy: string;
  }): Promise<ConsentApiKeyRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentApiKeyRow>(
        `INSERT INTO consent_api_keys (key_hash, key_prefix, label, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING ${RETURNING}`,
        [input.keyHash, input.keyPrefix, input.label, input.createdBy],
      );
      return rows[0]!;
    });
  }

  list(): Promise<ConsentApiKeyRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentApiKeyRow>(
        `SELECT ${RETURNING} FROM consent_api_keys ORDER BY created_at DESC`,
      );
      return rows;
    });
  }

  /** Tombstone, not delete (I4). Returns null if the id doesn't exist in this
   *  tenant (RLS) or was already revoked — the caller turns that into a 404. */
  revoke(id: string): Promise<ConsentApiKeyRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentApiKeyRow>(
        `UPDATE consent_api_keys SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${RETURNING}`,
        [id],
      );
      return rows[0] ?? null;
    });
  }
}
