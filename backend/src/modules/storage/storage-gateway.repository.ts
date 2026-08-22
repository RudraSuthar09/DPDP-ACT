import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The storage-plane pairing/session store — the sibling of GatewayRepository's
 * pairing/session methods, scoped to `storage_root_id` instead of `source_id`.
 * Reads/writes HASHES + metadata only — never a raw nonce/token, never a
 * filesystem path, never a customer value.
 */

export interface StoragePairingRow {
  id: string;
  tenant_id: string;
  user_id: string;
  storage_root_id: string;
  device_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface StorageSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  storage_root_id: string;
  device_id: string;
  pairing_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const PAIRING_COLS = 'id, tenant_id, user_id, storage_root_id, device_id, created_at, expires_at, consumed_at';
const SESSION_COLS = 'id, tenant_id, user_id, storage_root_id, device_id, pairing_id, created_at, expires_at, revoked_at';

@Injectable()
export class StorageGatewayRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  createPairing(input: {
    userId: string;
    storageRootId: string;
    deviceId: string;
    nonceHash: string;
    expiresAt: Date;
  }): Promise<StoragePairingRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StoragePairingRow>(
        `INSERT INTO gateway_storage_pairings (user_id, storage_root_id, device_id, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PAIRING_COLS}`,
        [input.userId, input.storageRootId, input.deviceId, input.nonceHash, input.expiresAt],
      );
      return rows[0]!;
    });
  }

  findPairingByHash(nonceHash: string): Promise<StoragePairingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StoragePairingRow>(
        `SELECT ${PAIRING_COLS} FROM gateway_storage_pairings WHERE nonce_hash = $1`,
        [nonceHash],
      );
      return rows[0] ?? null;
    });
  }

  consumePairing(id: string): Promise<StoragePairingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StoragePairingRow>(
        `UPDATE gateway_storage_pairings SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING ${PAIRING_COLS}`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  createSession(input: {
    userId: string;
    storageRootId: string;
    deviceId: string;
    pairingId: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<StorageSessionRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageSessionRow>(
        `INSERT INTO gateway_storage_sessions (user_id, storage_root_id, device_id, pairing_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SESSION_COLS}`,
        [input.userId, input.storageRootId, input.deviceId, input.pairingId, input.tokenHash, input.expiresAt],
      );
      return rows[0]!;
    });
  }

  findSessionByHash(tokenHash: string): Promise<StorageSessionRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageSessionRow>(
        `SELECT ${SESSION_COLS} FROM gateway_storage_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      return rows[0] ?? null;
    });
  }
}
