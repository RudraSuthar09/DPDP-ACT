import { randomUUID } from 'node:crypto';
import { GatewayService } from './gateway.service';
import { GatewayFolderService } from '../gateway-folders/gateway-folder.service';
import type { DataSource, StorageRoot } from '@dpdp/shared';

/**
 * The PAIRING LIFECYCLE, end to end at the service level — written after a
 * real Windows machine got stuck: the Gateway held a local pairing this
 * workspace no longer had, so pairing was refused while the dashboard offered
 * a fresh code.
 *
 * These tests pin the rules that make recovery predictable:
 *   - a second Gateway can never be enrolled while one is active (no silent
 *     swap, which is what makes "which device is mine?" answerable);
 *   - removal (de-enrolment) frees the slot, and re-pairing then works;
 *   - a revoked or removed device is denied everything afterwards;
 *   - the folders a workspace authorized are NOT deleted by re-pairing, and
 *     are never silently transferred to a different device.
 *
 * In-memory fakes stand in for the repository, mirroring its SQL semantics
 * (one active device per tenant, status transitions, session revocation).
 */

interface DeviceRow {
  id: string;
  tenant_id: string;
  status: 'active' | 'revoked' | 'removed';
  display_name: string;
  platform: string;
  agent_version: string;
  public_key: string;
  device_ref: string | null;
  endpoint: string | null;
  last_heartbeat_at: Date | null;
  enrolled_at: Date;
  revoked_at: Date | null;
  installation_id?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';

function fakes() {
  const devices: DeviceRow[] = [];
  const revokedSessions: string[] = [];
  const enrollments = new Map<string, { id: string; consumed: boolean }>();
  const audit: unknown[] = [];

  const repo = {
    findEnrollment: async (id: string) => {
      const e = enrollments.get(id);
      return e
        ? { id: e.id, tenant_id: TENANT, created_by: ACTOR, code_hash: 'x', code_prefix: 'y', expires_at: new Date(Date.now() + 600_000), consumed_at: e.consumed ? new Date() : null }
        : null;
    },
    consumeEnrollment: async (id: string) => {
      const e = enrollments.get(id);
      if (!e || e.consumed) return null;
      e.consumed = true;
      return { id };
    },
    findActiveDevice: async () => devices.find((d) => d.status === 'active') ?? null,
    findDevice: async (id: string) => devices.find((d) => d.id === id) ?? null,
    listDevices: async () => devices.filter((d) => d.status !== 'removed'),
    createDevice: async (i: { publicKey: string; deviceRef: string | null; platform: string; agentVersion: string; displayName: string }) => {
      const row: DeviceRow = {
        id: randomUUID(),
        tenant_id: TENANT,
        status: 'active',
        display_name: i.displayName,
        platform: i.platform,
        agent_version: i.agentVersion,
        public_key: i.publicKey,
        device_ref: i.deviceRef,
        endpoint: null,
        last_heartbeat_at: null,
        enrolled_at: new Date(),
        revoked_at: null,
        installation_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      devices.push(row);
      return row;
    },
    removeDevice: async (id: string) => {
      const d = devices.find((x) => x.id === id);
      if (d) d.status = 'removed';
      return d ?? null;
    },
    revokeDevice: async (id: string) => {
      const d = devices.find((x) => x.id === id && x.status === 'active');
      if (!d) return null;
      d.status = 'revoked';
      d.revoked_at = new Date();
      return d;
    },
    revokeDeviceSessions: async (id: string) => {
      revokedSessions.push(id);
    },
    touchHeartbeat: async (id: string, agentVersion: string) => {
      const d = devices.find((x) => x.id === id);
      if (d) {
        d.last_heartbeat_at = new Date();
        d.agent_version = agentVersion;
      }
      return d ?? null;
    },
    findSourceForDevice: async () => null,
    listBoundSourceIds: async () => [],
  };

  const svc = new GatewayService(
    repo as never,
    { getOrThrow: () => ({ tenantId: TENANT, userId: ACTOR, role: 'owner', correlationId: 'c' }) } as never,
    { annotate: (a: unknown) => audit.push(a) } as never,
    // tokens: the real minting is covered by gateway-token.spec.ts.
    { mintGatewayDeviceToken: () => ({ token: 'header.payload.signature', expiresIn: 3600 }) } as never,
    { get: async () => ({ id: 'src' }) } as never,
    { touchHeartbeat: async () => undefined, getById: async () => null } as never,
    { assertCapability: async () => undefined } as never,
    { get: () => '900' } as never,
  );
  return { svc, repo, devices, revokedSessions, enrollments, audit };
}

/** A PUBLIC key of realistic length — parseEnrollDevice requires >= 40 chars
 *  and refuses anything that looks like a private key. */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----${'A'.repeat(64)}-----END PUBLIC KEY-----`;

const enrollBody = (name: string) => ({
  publicKey: PUBLIC_KEY,
  platform: 'windows',
  agentVersion: '0.1.0',
  displayName: name,
  deviceRef: null,
});

describe('pairing lifecycle — one active Gateway, recoverable by design', () => {
  it('enrols the first Gateway and reports it as the active device', async () => {
    const { svc, enrollments } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    const { device } = await svc.enroll('e1', enrollBody('Hotel PC'));
    expect(device.status).toBe('active');
    expect((await svc.getActiveDevice())?.id).toBe(device.id);
  });

  it('REFUSES a second enrolment while one is active — never a silent swap', async () => {
    const { svc, enrollments, devices } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    enrollments.set('e2', { id: 'e2', consumed: false });
    await svc.enroll('e1', enrollBody('First PC'));
    await expect(svc.enroll('e2', enrollBody('Second PC'))).rejects.toThrow(/already connected/i);
    expect(devices.filter((d) => d.status === 'active')).toHaveLength(1);
    expect(devices[0]!.display_name).toBe('First PC');
  });

  it('de-enrolment frees the slot, revokes its sessions, and lets a NEW Gateway pair', async () => {
    const { svc, enrollments, revokedSessions } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    enrollments.set('e2', { id: 'e2', consumed: false });
    const first = (await svc.enroll('e1', enrollBody('Old PC'))).device;

    expect(await svc.deenroll(first.id)).toEqual({ removed: true });
    expect(revokedSessions).toContain(first.id);
    expect(await svc.getActiveDevice()).toBeNull(); // the dashboard's "Not connected"

    const second = (await svc.enroll('e2', enrollBody('New PC'))).device;
    expect(second.id).not.toBe(first.id);
    expect((await svc.getActiveDevice())?.displayName).toBe('New PC');
  });

  it('staff revocation has the same effect, and the revoked device is refused everything', async () => {
    const { svc, enrollments } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    const device = (await svc.enroll('e1', enrollBody('Hotel PC'))).device;

    await svc.revokeDevice(device.id, 'laptop replaced');
    expect(await svc.getActiveDevice()).toBeNull();
    // Heartbeat and de-enrolment with a token that still parses must fail.
    await expect(svc.heartbeat(device.id, '0.1.0')).rejects.toThrow();
    await expect(svc.deenroll(device.id)).rejects.toThrow();
  });

  it('a removed device cannot heartbeat its way back to active', async () => {
    const { svc, enrollments, devices } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    const device = (await svc.enroll('e1', enrollBody('Hotel PC'))).device;
    await svc.deenroll(device.id);
    await expect(svc.heartbeat(device.id, '0.1.0')).rejects.toThrow();
    expect(devices.find((d) => d.id === device.id)!.status).toBe('removed');
    expect(await svc.getActiveDevice()).toBeNull();
  });

  it('an enrolment code is single-use, so the same code cannot pair twice', async () => {
    const { svc, enrollments } = fakes();
    enrollments.set('e1', { id: 'e1', consumed: false });
    const first = (await svc.enroll('e1', enrollBody('PC'))).device;
    await svc.deenroll(first.id);
    await expect(svc.enroll('e1', enrollBody('PC again'))).rejects.toThrow();
  });
});

describe('re-pairing does not disturb the folders a workspace authorized', () => {
  /** The folder service over the same device set, so "after re-pairing" is
   *  the real sequence rather than a hypothetical. */
  function folderSetup(deviceId: () => string) {
    const sources: DataSource[] = [];
    const roots: StorageRoot[] = [];
    const svc = new GatewayFolderService(
      { listDevices: async () => [{ id: deviceId(), status: 'active' }] } as never,
      {
        list: async () => sources,
        create: async (i: { name: string; sourceKind: string }) => {
          const row = { id: randomUUID(), name: i.name, sourceKind: i.sourceKind, dataAccessMode: 'metadata_only', status: 'active' } as DataSource;
          sources.push(row);
          return row;
        },
        setMode: async (id: string) => {
          const row = sources.find((s) => s.id === id)!;
          (row as { dataAccessMode: string }).dataAccessMode = 'gateway_connected';
          return row;
        },
      } as never,
      {
        listRoots: async () => roots,
        createRoot: async (i: { name: string; provider: string; gatewayDeviceId: string | null }) => {
          const row = { id: randomUUID(), name: i.name, provider: i.provider, gatewayDeviceId: i.gatewayDeviceId, status: 'active' } as StorageRoot;
          roots.push(row);
          return row;
        },
      } as never,
      { assertCapability: async () => undefined } as never,
      { annotate: () => undefined } as never,
    );
    return { svc, sources, roots };
  }

  it('authorizations survive removal and re-pairing: the READ source is reused, not duplicated', async () => {
    let current = 'device-old';
    const { svc, sources } = folderSetup(() => current);
    const before = await svc.authorize(current, { label: 'Guest records', access: 'read' });

    current = 'device-new'; // the workspace removed the old Gateway and paired a new one
    const after = await svc.authorize(current, { label: 'Guest records', access: 'read' });

    expect(after.sourceId).toBe(before.sourceId); // same record, no duplicate
    expect(sources).toHaveLength(1);
  });

  it('a WRITE destination is never silently transferred to a different device', async () => {
    let current = 'device-old';
    const { svc, roots } = folderSetup(() => current);
    await svc.authorize(current, { label: 'Consent copies', access: 'write' });
    expect(roots[0]!.gatewayDeviceId).toBe('device-old');

    current = 'device-new';
    await expect(svc.authorize(current, { label: 'Consent copies', access: 'write' })).rejects.toThrow(/different Gateway or provider/);
    // The destination still belongs to the old device until a human decides.
    expect(roots[0]!.gatewayDeviceId).toBe('device-old');
    expect(roots).toHaveLength(1);
  });

  it('automatic folder registration works as soon as pairing is healthy again', async () => {
    const current = 'device-new';
    const { svc, sources, roots } = folderSetup(() => current);
    const result = await svc.authorize(current, { label: 'Hotel data', access: 'both' });
    expect(result.sourceId).toBe(sources[0]!.id);
    expect(result.storageRootId).toBe(roots[0]!.id);
    expect(sources[0]!.dataAccessMode).toBe('gateway_connected');
    expect(roots[0]).toMatchObject({ provider: 'gateway', gatewayDeviceId: current });
  });
});
