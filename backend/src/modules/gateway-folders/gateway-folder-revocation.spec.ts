import { randomUUID } from 'node:crypto';
import type { DataSource, StorageFolder, StorageMapping, StorageRoot } from '@dpdp/shared';
import { GatewayFolderService } from './gateway-folder.service';
import { parseRevokeFolder } from './gateway-folder.dto';
import { GATEWAY_DEVICE_PATHS } from '../../tenancy/gateway-device.middleware';

/**
 * "Remove folder" — the reverse of automatic registration.
 *
 * These tests are about what the customer is actually promised: the folder
 * stops being usable the moment they confirm, BOTH of its permissions go
 * together, nothing else is touched, nothing of theirs is deleted, and when
 * the Gateway computer is offline they are told the removal is waiting rather
 * than finished.
 */

const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

type Grant = 'read' | 'write' | 'both';

interface Seed {
  label: string;
  access: Grant;
  deviceId?: string;
  /** Consent-form fields saving into a folder under this root. */
  mappedFields?: number;
}

function setup(opts: { seed?: Seed[]; lastHeartbeatAt?: string | null; deviceStatus?: string } = {}) {
  const sources: DataSource[] = [];
  const roots: StorageRoot[] = [];
  const folders: StorageFolder[] = [];
  const mappings: StorageMapping[] = [];
  const calls = { setMode: [] as Array<[string, boolean]>, annotate: [] as Array<Record<string, unknown>> };

  const touch = (row: { updatedAt: string }) => {
    row.updatedAt = new Date(NOW).toISOString();
  };

  for (const s of opts.seed ?? []) {
    if (s.access === 'read' || s.access === 'both') {
      sources.push({
        id: randomUUID(),
        name: s.label,
        sourceKind: 'filesystem',
        dataAccessMode: 'gateway_connected',
        status: 'active',
        updatedAt: '2026-10-01T00:00:00.000Z',
      } as DataSource);
    }
    if (s.access === 'write' || s.access === 'both') {
      const root = {
        id: randomUUID(),
        name: s.label,
        provider: 'gateway',
        gatewayDeviceId: s.deviceId ?? DEVICE,
        status: 'active',
        updatedAt: '2026-10-01T00:00:00.000Z',
      } as StorageRoot;
      roots.push(root);
      for (let i = 0; i < (s.mappedFields ?? 0); i += 1) {
        const folder = { id: randomUUID(), storageRootId: root.id, name: `sub-${i}`, status: 'active' } as StorageFolder;
        folders.push(folder);
        mappings.push({
          id: randomUUID(),
          moduleKey: 'consent_form_field',
          entityId: randomUUID(),
          folderId: folder.id,
          status: 'active',
        } as StorageMapping);
      }
    }
  }

  const dataSources = {
    list: async (includeTombstoned = false) => (includeTombstoned ? sources : sources.filter((s) => s.status === 'active')),
    setMode: async (id: string, enabled: boolean) => {
      calls.setMode.push([id, enabled]);
      const row = sources.find((s) => s.id === id)!;
      (row as { dataAccessMode: string }).dataAccessMode = enabled ? 'gateway_connected' : 'metadata_only';
      return row;
    },
    remove: async (id: string) => {
      const row = sources.find((s) => s.id === id)!;
      (row as { status: string }).status = 'tombstoned';
      touch(row as { updatedAt: string });
      return row;
    },
  };
  const storage = {
    listRoots: async (includeTombstoned = false) => (includeTombstoned ? roots : roots.filter((r) => r.status === 'active')),
    listFolders: async (rootId: string) => folders.filter((f) => f.storageRootId === rootId),
    listMappings: async (moduleKey: string) => mappings.filter((m) => m.moduleKey === moduleKey),
    revokeGatewayRoot: async (id: string) => {
      const row = roots.find((r) => r.id === id)!;
      if (row.status !== 'active') throw new Error('already removed');
      if (row.provider !== 'gateway') throw new Error('not a gateway root');
      (row as { status: string }).status = 'tombstoned';
      touch(row as { updatedAt: string });
      return row;
    },
  };

  const svc = new GatewayFolderService(
    {
      listDevices: async () => [
        {
          id: DEVICE,
          status: opts.deviceStatus ?? 'active',
          lastHeartbeatAt: opts.lastHeartbeatAt === undefined ? new Date(NOW - 10_000).toISOString() : opts.lastHeartbeatAt,
        },
      ],
    } as never,
    dataSources as never,
    storage as never,
    { assertCapability: async () => undefined } as never,
    { annotate: (a: Record<string, unknown>) => calls.annotate.push(a) } as never,
  );
  return { svc, sources, roots, folders, mappings, calls };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('removing a connected folder', () => {
  it('ONLINE: revokes read and write together and reports it as done', async () => {
    const { svc, sources, roots } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });

    const res = await svc.revoke({ label: 'Hotel data' });

    expect(res.revokedSourceId).toBe(sources[0]!.id);
    expect(res.revokedStorageRootId).toBe(roots[0]!.id);
    expect(res.gatewayPending).toBe(false);
    expect(sources[0]!.status).toBe('tombstoned');
    expect(roots[0]!.status).toBe('tombstoned');
  });

  it('a folder with BOTH permissions loses both, even though they are two records', async () => {
    const { svc, calls } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    await svc.revoke({ label: 'Hotel data' });
    // Mode B is closed as well as the record tombstoned — either alone blocks
    // raw access; both together leave no ordering window.
    expect(calls.setMode).toEqual([[expect.any(String), false]]);
    expect(calls.annotate.at(-1)).toMatchObject({ afterState: { revoked: true } });
  });

  it('a read-only folder is revoked with no storage location to remove', async () => {
    const { svc, roots } = setup({ seed: [{ label: 'Guest records', access: 'read' }] });
    const res = await svc.revoke({ label: 'Guest records' });
    expect(res.revokedStorageRootId).toBeNull();
    expect(res.revokedSourceId).not.toBeNull();
    expect(roots).toEqual([]);
  });

  it('a write-only folder is revoked with no data source to remove', async () => {
    const { svc, sources } = setup({ seed: [{ label: 'Consent copies', access: 'write' }] });
    const res = await svc.revoke({ label: 'Consent copies' });
    expect(res.revokedSourceId).toBeNull();
    expect(res.revokedStorageRootId).not.toBeNull();
    expect(sources).toEqual([]);
  });

  it('OFFLINE: records the removal and says it is pending, instead of claiming success', async () => {
    const { svc, roots } = setup({
      seed: [{ label: 'Hotel data', access: 'both' }],
      lastHeartbeatAt: new Date(NOW - 60 * 60_000).toISOString(),
    });

    const res = await svc.revoke({ label: 'Hotel data' });

    expect(res.gatewayPending).toBe(true);
    // Central records change ANYWAY — this is what makes the backend fail
    // closed while the Gateway is unreachable.
    expect(roots[0]!.status).toBe('tombstoned');
    // ...and it stays listed as pending until the Gateway checks in again.
    expect(await svc.pendingRemovals()).toEqual([{ label: 'Hotel data' }]);
  });

  it('a Gateway that has never checked in at all is treated as offline', async () => {
    const { svc } = setup({ seed: [{ label: 'Hotel data', access: 'write' }], lastHeartbeatAt: null });
    expect((await svc.revoke({ label: 'Hotel data' })).gatewayPending).toBe(true);
  });

  it('stops being pending once the Gateway has checked in after the removal', async () => {
    const { svc } = setup({ seed: [{ label: 'Hotel data', access: 'both' }], lastHeartbeatAt: new Date(NOW - 60_000).toISOString() });
    await svc.revoke({ label: 'Hotel data' });
    expect(await svc.pendingRemovals()).toEqual([{ label: 'Hotel data' }]);

    // The next check-in is also when the Gateway fetches revocations.
    jest.setSystemTime(NOW + 30_000);
    const { svc: after } = setup({ seed: [], lastHeartbeatAt: new Date(NOW + 20_000).toISOString() });
    expect(await after.pendingRemovals()).toEqual([]);
  });

  it('is IDEMPOTENT: removing the same folder again changes nothing and is not an error', async () => {
    const { svc, sources, roots } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    await svc.revoke({ label: 'Hotel data' });

    const again = await svc.revoke({ label: 'Hotel data' });

    expect(again).toMatchObject({ revokedSourceId: null, revokedStorageRootId: null, affectedFormFields: 0 });
    expect(sources.filter((s) => s.status === 'active')).toEqual([]);
    expect(roots.filter((r) => r.status === 'active')).toEqual([]);
  });

  it('a label that was never a folder is not an error either', async () => {
    const { svc } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    const res = await svc.revoke({ label: 'Never existed' });
    expect(res).toMatchObject({ revokedSourceId: null, revokedStorageRootId: null });
  });

  it('leaves every OTHER folder exactly as it was', async () => {
    const { svc, sources, roots } = setup({
      seed: [
        { label: 'Hotel data', access: 'both' },
        { label: 'Guest records', access: 'read' },
        { label: 'Consent copies', access: 'write' },
      ],
    });

    await svc.revoke({ label: 'Hotel data' });

    expect(sources.find((s) => s.name === 'Guest records')).toMatchObject({ status: 'active', dataAccessMode: 'gateway_connected' });
    expect(roots.find((r) => r.name === 'Consent copies')).toMatchObject({ status: 'active' });
  });

  it('reports how many consent-form fields lost their destination, and repoints none of them', async () => {
    const { svc, mappings } = setup({ seed: [{ label: 'Hotel data', access: 'write', mappedFields: 2 }] });

    const res = await svc.revoke({ label: 'Hotel data' });

    expect(res.affectedFormFields).toBe(2);
    // Nothing is deleted and nothing is sent somewhere else: the mappings
    // still name the folder they were given, and now simply cannot be used.
    expect(mappings.every((m) => m.status === 'active')).toBe(true);
    expect(new Set(mappings.map((m) => m.folderId)).size).toBe(2);
  });

  it('never leaks an id, a path or a device into what the customer is shown', async () => {
    const { svc, calls } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    await svc.revoke({ label: 'Hotel data' });
    const reason = String((calls.annotate.at(-1) as { reason: string }).reason);
    // The audit entry may carry ids in its state (that is its job); the
    // human-readable reason is a sentence about a folder name.
    expect(reason).toContain('Hotel data');
    expect(reason).not.toMatch(/[A-Za-z]:\\|\/\//);
  });
});

describe('what the Gateway is told, and what it may decide', () => {
  it('reports the revoked ids for THIS device, so the Gateway can stop serving them', async () => {
    const { svc, sources, roots } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    await svc.revoke({ label: 'Hotel data' });

    const revocations = await svc.revocationsFor(DEVICE);

    expect(revocations.revokedSourceIds).toEqual([sources[0]!.id]);
    expect(revocations.revokedStorageRootIds).toEqual([roots[0]!.id]);
  });

  it('never reports another device\'s revoked storage location', async () => {
    const { svc } = setup({
      seed: [
        { label: 'Hotel data', access: 'write', deviceId: OTHER_DEVICE },
        { label: 'Consent copies', access: 'write', deviceId: DEVICE },
      ],
    });
    await svc.revoke({ label: 'Hotel data' });
    await svc.revoke({ label: 'Consent copies' });

    const revocations = await svc.revocationsFor(DEVICE);

    expect(revocations.revokedStorageRootIds).toHaveLength(1);
  });

  it('refuses to answer a device that is not an active Gateway of this workspace', async () => {
    const { svc } = setup({ seed: [], deviceStatus: 'revoked' });
    await expect(svc.revocationsFor(DEVICE)).rejects.toThrow(/not active/i);
    // An id belonging to nobody is indistinguishable from another tenant's —
    // RLS makes listDevices tenant-scoped, so there is nothing to compare.
    await expect(svc.revocationsFor(OTHER_DEVICE)).rejects.toThrow(/not active/i);
  });

  it('only the READ of revocations is reachable with a device token; removal never is', () => {
    expect(GATEWAY_DEVICE_PATHS.has('/gateway/folders/revocations')).toBe(true);
    // A compromised Gateway must not be able to revoke — or un-revoke — a
    // folder. Both of those are staff routes behind a session and roles.
    expect(GATEWAY_DEVICE_PATHS.has('/gateway/folders/revoke')).toBe(false);
    expect(GATEWAY_DEVICE_PATHS.has('/gateway/folders/pending-removals')).toBe(false);
  });

  it('nothing in the revocation reply can grant the Gateway anything', async () => {
    const { svc } = setup({ seed: [{ label: 'Hotel data', access: 'both' }] });
    const revocations = await svc.revocationsFor(DEVICE);
    expect(Object.keys(revocations).sort()).toEqual(['revokedSourceIds', 'revokedStorageRootIds']);
  });
});

describe('the remove-folder request body', () => {
  it('takes a label and ignores every identity field a caller might try to add', () => {
    expect(
      parseRevokeFolder({ label: ' Hotel data ', tenantId: 'other', deviceId: 'x', storageRootId: 'y' }),
    ).toEqual({ label: 'Hotel data' });
  });

  it('refuses a path masquerading as a label', () => {
    for (const label of ['C:\\Secrets', '../../etc', '//server/share', 'a/b']) {
      expect(() => parseRevokeFolder({ label })).toThrow(/folder name, not a path/);
    }
  });

  it('refuses a missing, empty or over-long label', () => {
    expect(() => parseRevokeFolder({})).toThrow(/label is required/);
    expect(() => parseRevokeFolder({ label: '   ' })).toThrow(/between 1 and/);
    expect(() => parseRevokeFolder({ label: 'x'.repeat(121) })).toThrow(/between 1 and/);
  });
});
