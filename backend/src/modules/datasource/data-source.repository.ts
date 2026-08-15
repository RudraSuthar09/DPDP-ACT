import { Injectable } from '@nestjs/common';
import type { DataAccessMode, DataSourceKind } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

export interface DataSourceRow {
  id: string;
  tenant_id: string;
  name: string;
  source_kind: DataSourceKind;
  data_access_mode: DataAccessMode;
  status: 'active' | 'tombstoned';
  connection_hint: string | null;
  /** Phase 3G-1: the client-chosen COLUMN NAME that identifies a customer in
   *  this source. Never a value; NULL until explicitly configured. */
  identity_column: string | null;
  gateway_binding_ref: string | null;
  mode_last_changed_at: Date | null;
  mode_last_changed_by: string | null;
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * `data_sources` — metadata/config for a client data source and its per-source
 * access mode (I1/§2.1). See the migration header.
 *
 * READ THE METHOD SIGNATURES AS THE INVARIANT (same discipline as
 * FulfilmentRepository): not one method here accepts, returns, or touches a
 * customer value, a row of client data, a payload, or a secret. There is no
 * `readRows`, no `read`, no `fetchData`, no `getValues`. This repository manages
 * METADATA about a source; it has no capability to read the data behind it, and
 * must never grow one — Mode-B raw access is a SEPARATE future Gateway
 * capability that will not live here.
 */
@Injectable()
export class DataSourceRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(input: {
    name: string;
    sourceKind: DataSourceKind;
    connectionHint: string | null;
    createdBy: string | null;
  }): Promise<DataSourceRow> {
    return this.db.withTenant(async (client) => {
      // data_access_mode is NOT accepted here — a source is ALWAYS created in the
      // default 'metadata_only' mode (the column default). Enabling Mode B is a
      // separate, explicit, privileged, audited operation (setMode).
      const { rows } = await client.query<DataSourceRow>(
        `INSERT INTO data_sources (name, source_kind, connection_hint, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.name, input.sourceKind, input.connectionHint, input.createdBy],
      );
      return rows[0]!;
    });
  }

  list(includeTombstoned: boolean): Promise<DataSourceRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>(
        `SELECT * FROM data_sources
          ${includeTombstoned ? '' : "WHERE status = 'active'"}
          ORDER BY created_at DESC`,
      );
      return rows;
    });
  }

  findOne(id: string): Promise<DataSourceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>('SELECT * FROM data_sources WHERE id = $1', [id]);
      return rows[0] ?? null;
    });
  }

  updateMetadata(
    id: string,
    input: { name: string; connectionHint: string | null },
  ): Promise<DataSourceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>(
        `UPDATE data_sources
            SET name = $2, connection_hint = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [id, input.name, input.connectionHint],
      );
      return rows[0] ?? null;
    });
  }

  /** The privileged mode toggle. Records who/when in addition to the S5 entry. */
  setMode(id: string, mode: DataAccessMode, actorId: string | null): Promise<DataSourceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>(
        `UPDATE data_sources
            SET data_access_mode = $2, mode_last_changed_at = now(), mode_last_changed_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [id, mode, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Phase 3G-1: record the client-chosen identity column. Config only — no
   * lookup, no customer value ever touches this method. NULL clears it.
   */
  setIdentityColumn(id: string, identityColumn: string | null): Promise<DataSourceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>(
        `UPDATE data_sources
            SET identity_column = $2
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [id, identityColumn],
      );
      return rows[0] ?? null;
    });
  }

  /** Soft-delete (I4) — there is no DELETE grant on this table. */
  tombstone(id: string, reason: string | null, actorId: string | null): Promise<DataSourceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataSourceRow>(
        `UPDATE data_sources
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(), tombstoned_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [id, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }
}
