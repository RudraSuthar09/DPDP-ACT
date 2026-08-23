import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * Central DPDP Storage automatic sync — Enterprise half
 * (1737004800000_storage-server-provider.sql).
 *
 * Covers the pieces that are genuinely database-enforced (constraints, the
 * cross-tenant scheduler peephole, and the idempotency the Enterprise
 * synchronizer's folder/mapping resolution relies on) — the same style as
 * data-principals.isolation-spec.ts: real SQL, under RLS, no mocks. The
 * synchronizer's actual filesystem writes are covered by live Docker
 * verification (a real host directory), not here.
 */
describe('storage_roots "server" provider — Enterprise automatic sync substrate', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);
  const B: TenantFixture = makeFixture(B_MARKER);

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
    await seedTenant(pool, B);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createServerRoot(tenantId: string, name: string, rootPath: string | null): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_roots (name, provider, root_path) VALUES ($1, 'server', $2) RETURNING id`,
        [name, rootPath],
      );
      return rows[0]!.id;
    });
  }

  it('a "server" root REQUIRES root_path — the worker has nothing to synchronize to otherwise', async () => {
    await expect(createServerRoot(A.id, `${A_MARKER}-no-path-${randomUUID().slice(0, 8)}`, null)).rejects.toThrow(
      /storage_roots_provider_binding/,
    );
  });

  it('a "server" root REJECTS a gateway_device_id — this is explicitly not the Gateway path', async () => {
    // A nonexistent gateway_device_id is caught by the EARLIER tenant-binding
    // trigger (storage_roots_check_gateway_device_tenant) before the CHECK
    // constraint even runs — either guard rejecting the insert proves the
    // real point: 'server' + a gateway device can never coexist.
    await expect(
      asTenant(pool, A.id, (c) =>
        c.query(
          `INSERT INTO storage_roots (name, provider, root_path, gateway_device_id) VALUES ($1, 'server', $2, gen_random_uuid())`,
          [`${A_MARKER}-fake-gateway-${randomUUID().slice(0, 8)}`, '/some/path'],
        ),
      ),
    ).rejects.toThrow();
  });

  it('a valid "server" root (path set, no gateway device) is accepted', async () => {
    const id = await createServerRoot(A.id, `${A_MARKER}-valid-${randomUUID().slice(0, 8)}`, '/srv/dpdp-storage');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('app.storage_server_roots_active() — the sync worker\'s cross-tenant scheduler peephole', () => {
    it('returns an active "server" root with the correct tenant_id and path, and excludes "local"/"gateway" roots', async () => {
      const marker = randomUUID().slice(0, 8);
      const serverRootPath = `/srv/dpdp-${marker}`;
      const serverRootId = await createServerRoot(A.id, `${A_MARKER}-peephole-${marker}`, serverRootPath);
      // A decoy 'local' root for the SAME tenant — must never appear via this peephole.
      const decoyId = await asTenant(pool, A.id, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO storage_roots (name, provider) VALUES ($1, 'local') RETURNING id`,
          [`${A_MARKER}-decoy-local-${marker}`],
        );
        return rows[0]!.id;
      });

      // Fixture tenants are reused across `it` blocks in this file, so scope
      // strictly to the two roots THIS test just created, not "everything
      // tenant A has ever had" — otherwise an earlier test's root leaks in.
      const { rows } = await pool.query<{ tenant_id: string; storage_root_id: string; root_path: string }>(
        'SELECT tenant_id, storage_root_id, root_path FROM app.storage_server_roots_active() WHERE storage_root_id = ANY($1::uuid[])',
        [[serverRootId, decoyId]],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.storage_root_id).toBe(serverRootId);
      expect(rows[0]!.tenant_id).toBe(A.id);
      expect(rows[0]!.root_path).toBe(serverRootPath);
    });

    it('excludes a TOMBSTONED "server" root — a removed root is not swept', async () => {
      const marker = randomUUID().slice(0, 8);
      const id = await createServerRoot(A.id, `${A_MARKER}-tombstoned-${marker}`, `/srv/dpdp-tomb-${marker}`);
      await asTenant(pool, A.id, (c) =>
        c.query(`UPDATE storage_roots SET status = 'tombstoned' WHERE id = $1`, [id]),
      );
      const { rows } = await pool.query('SELECT 1 FROM app.storage_server_roots_active() WHERE storage_root_id = $1', [id]);
      expect(rows).toHaveLength(0);
    });

    it('correctly distinguishes TWO tenants each with their own active "server" root — no cross-tenant mixing', async () => {
      const marker = randomUUID().slice(0, 8);
      const pathA = `/srv/tenant-a-${marker}`;
      const pathB = `/srv/tenant-b-${marker}`;
      const idA = await createServerRoot(A.id, `${A_MARKER}-multi-${marker}`, pathA);
      const idB = await createServerRoot(B.id, `${B_MARKER}-multi-${marker}`, pathB);

      const { rows } = await pool.query<{ tenant_id: string; storage_root_id: string; root_path: string }>(
        'SELECT tenant_id, storage_root_id, root_path FROM app.storage_server_roots_active() WHERE storage_root_id = ANY($1::uuid[])',
        [[idA, idB]],
      );
      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((r) => [r.storage_root_id, r]));
      expect(byId.get(idA)?.tenant_id).toBe(A.id);
      expect(byId.get(idA)?.root_path).toBe(pathA);
      expect(byId.get(idB)?.tenant_id).toBe(B.id);
      expect(byId.get(idB)?.root_path).toBe(pathB);
    });
  });

  it('tenant B cannot see tenant A\'s "server" storage root under ordinary RLS (only the SECURITY DEFINER peephole crosses tenants)', async () => {
    const id = await createServerRoot(A.id, `${A_MARKER}-isolated-${randomUUID().slice(0, 8)}`, '/srv/isolated');
    const asB = await asTenant(pool, B.id, (c) => c.query('SELECT * FROM storage_roots WHERE id = $1', [id]));
    expect(asB.rows).toHaveLength(0);
  });

  describe('customer-folder mapping idempotency (what resolveCustomerFolder relies on)', () => {
    it('upserting the SAME (data_principal, customerId) mapping twice never creates a second row — running the synchronizer twice cannot duplicate a customer folder', async () => {
      const rootId = await createServerRoot(A.id, `${A_MARKER}-idem-root-${randomUUID().slice(0, 8)}`, '/srv/idem');
      const customerId = randomUUID();
      const folderId1 = await asTenant(pool, A.id, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO storage_folders (storage_root_id, name) VALUES ($1, $2) RETURNING id`,
          [rootId, `Customer-${customerId.slice(0, 8)}`],
        );
        return rows[0]!.id;
      });

      await asTenant(pool, A.id, (c) =>
        c.query(
          `INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('data_principal', $1, $2)
           ON CONFLICT ON CONSTRAINT storage_mappings_module_entity_uq DO UPDATE SET folder_id = EXCLUDED.folder_id, status = 'active'`,
          [customerId, folderId1],
        ),
      );
      // Second "sync run" for the same customer — same folder, upserted again.
      await asTenant(pool, A.id, (c) =>
        c.query(
          `INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('data_principal', $1, $2)
           ON CONFLICT ON CONSTRAINT storage_mappings_module_entity_uq DO UPDATE SET folder_id = EXCLUDED.folder_id, status = 'active'`,
          [customerId, folderId1],
        ),
      );

      const { rows } = await asTenant(pool, A.id, (c) =>
        c.query('SELECT id FROM storage_mappings WHERE module_key = $1 AND entity_id = $2', ['data_principal', customerId]),
      );
      expect(rows).toHaveLength(1);
    });
  });
});
