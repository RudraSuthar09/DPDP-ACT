import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DataSource, StorageRoot } from '@dpdp/shared';
import { GatewayFolderService } from './gateway-folder.service';
import { parseAuthorizeFolder } from './gateway-folder.dto';
import { GATEWAY_DEVICE_PATHS } from '../../tenancy/gateway-device.middleware';

/**
 * Automatic folder registration — the operation that removes hand-copied ids
 * from Gateway Setup. These tests are mostly about the SECURITY boundary:
 * what a device can and cannot cause to happen in a tenant's workspace.
 */

const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';

function setup(opts: { devices?: Array<{ id: string; status: string }>; capability?: boolean } = {}) {
  const sources: DataSource[] = [];
  const roots: StorageRoot[] = [];
  const calls = { setMode: [] as Array<[string, boolean]>, annotate: [] as unknown[] };

  const dataSources = {
    list: async () => sources,
    create: async (i: { name: string; sourceKind: string }) => {
      const row = { id: randomUUID(), name: i.name, sourceKind: i.sourceKind, dataAccessMode: 'metadata_only', status: 'active' } as DataSource;
      sources.push(row);
      return row;
    },
    setMode: async (id: string, enabled: boolean) => {
      calls.setMode.push([id, enabled]);
      const row = sources.find((s) => s.id === id)!;
      (row as { dataAccessMode: string }).dataAccessMode = enabled ? 'gateway_connected' : 'metadata_only';
      return row;
    },
  };
  const storage = {
    listRoots: async () => roots,
    createRoot: async (i: { name: string; provider: string; gatewayDeviceId: string | null }) => {
      const row = { id: randomUUID(), name: i.name, provider: i.provider, gatewayDeviceId: i.gatewayDeviceId, status: 'active' } as StorageRoot;
      roots.push(row);
      return row;
    },
  };
  const svc = new GatewayFolderService(
    { listDevices: async () => opts.devices ?? [{ id: DEVICE, status: 'active' }] } as never,
    dataSources as never,
    storage as never,
    {
      assertCapability: async () => {
        if (opts.capability === false) throw new Error('CAPABILITY_REQUIRED');
      },
    } as never,
    { annotate: (a: unknown) => calls.annotate.push(a) } as never,
  );
  return { svc, sources, roots, calls };
}

describe('authorize-folder — the records are created automatically, by label', () => {
  it('read-only: creates a Gateway-connected filesystem source and NO storage root', async () => {
    const { svc, sources, roots } = setup();
    const r = await svc.authorize(DEVICE, { label: 'Guest records', access: 'read' });
    expect(r.storageRootId).toBeNull();
    expect(r.sourceId).toBe(sources[0]!.id);
    expect(sources[0]).toMatchObject({ name: 'Guest records', sourceKind: 'filesystem', dataAccessMode: 'gateway_connected' });
    expect(roots).toEqual([]);
  });

  it('write-only: creates a Gateway storage root bound to THIS device and NO data source', async () => {
    const { svc, sources, roots } = setup();
    const r = await svc.authorize(DEVICE, { label: 'Consent copies', access: 'write' });
    expect(r.sourceId).toBeNull();
    expect(roots[0]).toMatchObject({ name: 'Consent copies', provider: 'gateway', gatewayDeviceId: DEVICE });
    expect(r.storageRootId).toBe(roots[0]!.id);
    expect(sources).toEqual([]);
  });

  it('both: ONE folder, TWO separate grants — never one implying the other', async () => {
    const { svc, sources, roots } = setup();
    const r = await svc.authorize(DEVICE, { label: 'Hotel data', access: 'both' });
    expect(r.sourceId).toBe(sources[0]!.id);
    expect(r.storageRootId).toBe(roots[0]!.id);
    expect(sources).toHaveLength(1);
    expect(roots).toHaveLength(1);
  });

  it('is idempotent: re-authorizing the same label reuses both records, never duplicating them', async () => {
    const { svc, sources, roots } = setup();
    const first = await svc.authorize(DEVICE, { label: 'Hotel data', access: 'both' });
    const again = await svc.authorize(DEVICE, { label: 'Hotel data', access: 'both' });
    expect(again).toEqual(first);
    expect(sources).toHaveLength(1);
    expect(roots).toHaveLength(1);
  });

  it('upgrading read -> both reuses the SAME source and adds only the write root', async () => {
    const { svc, sources, roots } = setup();
    const read = await svc.authorize(DEVICE, { label: 'Hotel data', access: 'read' });
    const both = await svc.authorize(DEVICE, { label: 'Hotel data', access: 'both' });
    expect(both.sourceId).toBe(read.sourceId);
    expect(sources).toHaveLength(1);
    expect(roots).toHaveLength(1);
  });

  it('a source left in metadata-only is put back into Gateway-connected mode on re-authorization', async () => {
    const { svc, sources, calls } = setup();
    await svc.authorize(DEVICE, { label: 'Hotel data', access: 'read' });
    (sources[0] as { dataAccessMode: string }).dataAccessMode = 'metadata_only'; // staff turned it off
    await svc.authorize(DEVICE, { label: 'Hotel data', access: 'read' });
    expect(calls.setMode.filter(([, enabled]) => enabled)).toHaveLength(2);
  });

  it('records the grant in the audit chain — the permission, never a path', async () => {
    const { svc, calls } = setup();
    await svc.authorize(DEVICE, { label: 'Guest records', access: 'both' });
    const entry = calls.annotate[0] as { targetType: string; targetId: string; reason: string; afterState: Record<string, unknown> };
    expect(entry).toMatchObject({ targetType: 'gateway_device', targetId: DEVICE });
    expect(entry.afterState.access).toBe('both');
    expect(entry.reason).toContain('Guest records');
    expect(JSON.stringify(entry)).not.toMatch(/[A-Z]:\\|\/home\/|\\\\/);
  });
});

describe('authorize-folder — what a device CANNOT do', () => {
  it('a revoked or unknown device gets nothing: no records, forbidden', async () => {
    for (const devices of [[{ id: DEVICE, status: 'revoked' }], [{ id: OTHER_DEVICE, status: 'active' }], []]) {
      const { svc, sources, roots } = setup({ devices });
      await expect(svc.authorize(DEVICE, { label: 'X', access: 'both' })).rejects.toThrow(/not active for this workspace/);
      expect([...sources, ...roots]).toEqual([]);
    }
  });

  it('a tenant without the Gateway capability cannot have records created for it', async () => {
    const { svc, sources, roots } = setup({ capability: false });
    await expect(svc.authorize(DEVICE, { label: 'X', access: 'read' })).rejects.toThrow();
    expect([...sources, ...roots]).toEqual([]);
  });

  it('it cannot take over a storage location belonging to another device or provider', async () => {
    const { svc, roots } = setup();
    roots.push({ id: 'other', name: 'Shared', provider: 'gateway', gatewayDeviceId: OTHER_DEVICE, status: 'active' } as StorageRoot);
    await expect(svc.authorize(DEVICE, { label: 'Shared', access: 'write' })).rejects.toThrow(/different Gateway or provider/);
    roots.push({ id: 'local', name: 'Local', provider: 'local', gatewayDeviceId: null, status: 'active' } as StorageRoot);
    await expect(svc.authorize(DEVICE, { label: 'Local', access: 'write' })).rejects.toThrow(/different Gateway or provider/);
    // Neither attempt rebound anything.
    expect(roots.find((r) => r.id === 'other')!.gatewayDeviceId).toBe(OTHER_DEVICE);
  });

  it('cannot create unbounded records: the per-workspace folder cap is enforced', async () => {
    const { svc, roots } = setup();
    for (let i = 0; i < 50; i += 1) {
      roots.push({ id: `r${i}`, name: `R${i}`, provider: 'gateway', gatewayDeviceId: DEVICE, status: 'active' } as StorageRoot);
    }
    await expect(svc.authorize(DEVICE, { label: 'One more', access: 'write' })).rejects.toThrow(/already has 50 Gateway folders/);
  });

  it('the body cannot carry identity or a location: those fields are not read at all', () => {
    const parsed = parseAuthorizeFolder({
      label: 'Guest records',
      access: 'read',
      // All of this is ignored — identity comes from the verified token.
      tenantId: 'attacker-tenant',
      deviceId: OTHER_DEVICE,
      userId: 'someone',
      sourceId: 'pre-chosen',
      storageRootId: 'pre-chosen',
      rootPath: 'C:\\Windows',
    });
    expect(parsed).toEqual({ label: 'Guest records', access: 'read' });

    const dto = readFileSync(join(__dirname, 'gateway-folder.dto.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const field of ['tenantId', 'deviceId', 'userId', 'sourceId', 'storageRootId', 'rootPath']) {
      expect({ field, read: dto.includes(field) }).toEqual({ field, read: false });
    }
  });

  it('a label that is really a path is refused — the central platform never learns the location', () => {
    for (const label of ['C:\\Hotel\\Guests', '/var/data', '\\\\server\\share', '..', 'a/b', 'a\\b', 'x\0y', '', '   ', 'x'.repeat(121)]) {
      expect(() => parseAuthorizeFolder({ label, access: 'read' })).toThrow();
    }
  });

  it('access must be one of the three explicit permissions', () => {
    for (const access of ['admin', 'READ', '', undefined, null, 1, ['read']]) {
      expect(() => parseAuthorizeFolder({ label: 'X', access })).toThrow(/access must be one of/);
    }
  });
});

describe('authorize-folder — wiring and layering', () => {
  it('the route is device-authenticated, audited, and listed for the device middleware', () => {
    expect(GATEWAY_DEVICE_PATHS.has('/gateway/folders')).toBe(true);
    const controller = readFileSync(join(__dirname, 'gateway-folder.controller.ts'), 'utf8');
    expect(controller).toContain('@AllowGatewayDevice()');
    expect(controller).toContain("@Audited('gateway.folder.authorized')");
    expect(controller).toContain('@UseGuards(TenantGuard)');
    expect(controller).toContain('req.gatewayDeviceId');
  });

  it('it owns no table: it composes the existing services, never a repository', () => {
    const service = readFileSync(join(__dirname, 'gateway-folder.service.ts'), 'utf8');
    for (const forbidden of ['Repository', 'withTenant', '.query(', 'INSERT ', 'UPDATE ']) {
      expect({ forbidden, present: service.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    expect(service).toContain('DataSourceService');
    expect(service).toContain('StorageService');
  });

  it('the existing STAFF routes keep their own authentication and capability checks', () => {
    const dsController = readFileSync(join(__dirname, '..', 'datasource', 'data-source.controller.ts'), 'utf8');
    const stController = readFileSync(join(__dirname, '..', 'storage', 'storage.controller.ts'), 'utf8');
    // Neither staff controller gained a device-token escape hatch.
    expect(dsController).not.toContain('AllowGatewayDevice');
    expect(stController.match(/@AllowGatewayDevice\(\)/g) ?? []).toHaveLength(1); // only the pre-existing redeem route
  });
});
