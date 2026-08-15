import { Injectable } from '@nestjs/common';
import type { GatewayAgentPlatform } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The Gateway control-plane store. Reads/writes device, enrolment, pairing and
 * session METADATA + HASHES only — never a private key, a raw code/nonce/token,
 * a credential, or a customer value (read the columns as the invariant, same
 * discipline as DataSourceRepository / FulfilmentRepository).
 */

export interface GatewayDeviceRow {
  id: string;
  tenant_id: string;
  public_key: string;
  device_ref: string | null;
  platform: GatewayAgentPlatform;
  agent_version: string;
  display_name: string;
  status: 'active' | 'revoked' | 'removed';
  enrolled_by: string | null;
  enrolled_at: Date;
  last_heartbeat_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  updated_at: Date;
}

export interface GatewayEnrollmentRow {
  id: string;
  tenant_id: string;
  code_prefix: string;
  label: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_device_id: string | null;
}

export interface GatewayPairingRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_id: string;
  device_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface GatewaySessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_id: string;
  device_id: string;
  pairing_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const DEVICE_COLS =
  'id, tenant_id, public_key, device_ref, platform, agent_version, display_name, status, ' +
  'enrolled_by, enrolled_at, last_heartbeat_at, revoked_at, revoked_by, revoke_reason, updated_at';

@Injectable()
export class GatewayRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- enrolments -----------------------------------------------------------

  createEnrollment(input: {
    codeHash: string;
    codePrefix: string;
    label: string | null;
    createdBy: string;
    expiresAt: Date;
  }): Promise<GatewayEnrollmentRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayEnrollmentRow>(
        `INSERT INTO gateway_enrollments (code_hash, code_prefix, label, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, code_prefix, label, created_by, created_at, expires_at, consumed_at, consumed_device_id`,
        [input.codeHash, input.codePrefix, input.label, input.createdBy, input.expiresAt],
      );
      return rows[0]!;
    });
  }

  findEnrollment(id: string): Promise<GatewayEnrollmentRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayEnrollmentRow>(
        `SELECT id, tenant_id, code_prefix, label, created_by, created_at, expires_at, consumed_at, consumed_device_id
         FROM gateway_enrollments WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  consumeEnrollment(id: string, deviceId: string): Promise<GatewayEnrollmentRow | null> {
    return this.db.withTenant(async (client) => {
      // Single-use guard is in the WHERE: only an unconsumed row updates, so a
      // concurrent second redeem returns no row and fails closed.
      const { rows } = await client.query<GatewayEnrollmentRow>(
        `UPDATE gateway_enrollments
            SET consumed_at = now(), consumed_device_id = $2
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id, tenant_id, code_prefix, label, created_by, created_at, expires_at, consumed_at, consumed_device_id`,
        [id, deviceId],
      );
      return rows[0] ?? null;
    });
  }

  // --- devices --------------------------------------------------------------

  createDevice(input: {
    publicKey: string;
    deviceRef: string | null;
    platform: GatewayAgentPlatform;
    agentVersion: string;
    displayName: string;
    enrolledBy: string | null;
  }): Promise<GatewayDeviceRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `INSERT INTO gateway_devices (public_key, device_ref, platform, agent_version, display_name, enrolled_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${DEVICE_COLS}`,
        [input.publicKey, input.deviceRef, input.platform, input.agentVersion, input.displayName, input.enrolledBy],
      );
      return rows[0]!;
    });
  }

  findDevice(id: string): Promise<GatewayDeviceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `SELECT ${DEVICE_COLS} FROM gateway_devices WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  listDevices(): Promise<GatewayDeviceRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `SELECT ${DEVICE_COLS} FROM gateway_devices ORDER BY enrolled_at DESC`,
      );
      return rows;
    });
  }

  touchHeartbeat(id: string, agentVersion: string): Promise<GatewayDeviceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `UPDATE gateway_devices
            SET last_heartbeat_at = now(), agent_version = $2
          WHERE id = $1 AND status = 'active'
          RETURNING ${DEVICE_COLS}`,
        [id, agentVersion],
      );
      return rows[0] ?? null;
    });
  }

  revokeDevice(id: string, actorId: string | null, reason: string | null): Promise<GatewayDeviceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `UPDATE gateway_devices
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${DEVICE_COLS}`,
        [id, actorId, reason],
      );
      return rows[0] ?? null;
    });
  }

  /** De-enrolment (clean uninstall): the device removes itself. */
  removeDevice(id: string): Promise<GatewayDeviceRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayDeviceRow>(
        `UPDATE gateway_devices
            SET status = 'removed'
          WHERE id = $1 AND status = 'active'
          RETURNING ${DEVICE_COLS}`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /** Fail closed on revocation: kill any live sessions for a device. */
  revokeDeviceSessions(deviceId: string): Promise<void> {
    return this.db.withTenant(async (client) => {
      await client.query(
        `UPDATE gateway_sessions SET revoked_at = now()
          WHERE device_id = $1 AND revoked_at IS NULL`,
        [deviceId],
      );
    });
  }

  // --- pairings -------------------------------------------------------------

  createPairing(input: {
    userId: string;
    sourceId: string;
    deviceId: string;
    nonceHash: string;
    expiresAt: Date;
  }): Promise<GatewayPairingRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayPairingRow>(
        `INSERT INTO gateway_pairings (user_id, source_id, device_id, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, user_id, source_id, device_id, created_at, expires_at, consumed_at`,
        [input.userId, input.sourceId, input.deviceId, input.nonceHash, input.expiresAt],
      );
      return rows[0]!;
    });
  }

  findPairingByHash(nonceHash: string): Promise<GatewayPairingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayPairingRow>(
        `SELECT id, tenant_id, user_id, source_id, device_id, created_at, expires_at, consumed_at
         FROM gateway_pairings WHERE nonce_hash = $1`,
        [nonceHash],
      );
      return rows[0] ?? null;
    });
  }

  consumePairing(id: string): Promise<GatewayPairingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewayPairingRow>(
        `UPDATE gateway_pairings SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id, tenant_id, user_id, source_id, device_id, created_at, expires_at, consumed_at`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  // --- sessions -------------------------------------------------------------

  createSession(input: {
    userId: string;
    sourceId: string;
    deviceId: string;
    pairingId: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<GatewaySessionRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewaySessionRow>(
        `INSERT INTO gateway_sessions (user_id, source_id, device_id, pairing_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, user_id, source_id, device_id, pairing_id, created_at, expires_at, revoked_at`,
        [input.userId, input.sourceId, input.deviceId, input.pairingId, input.tokenHash, input.expiresAt],
      );
      return rows[0]!;
    });
  }

  findSessionByHash(tokenHash: string): Promise<GatewaySessionRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<GatewaySessionRow>(
        `SELECT id, tenant_id, user_id, source_id, device_id, pairing_id, created_at, expires_at, revoked_at
         FROM gateway_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      return rows[0] ?? null;
    });
  }

  revokeSession(id: string): Promise<void> {
    return this.db.withTenant(async (client) => {
      await client.query(`UPDATE gateway_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    });
  }
}
