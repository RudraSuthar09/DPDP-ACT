import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * Customer Storage foundation — isolation + persistence + no-Gateway-required
 * proof (see the migration headers on 1737004100000_storage-configuration.sql,
 * 1737004200000_gateway-storage-plane.sql, and
 * 1737004300000_storage-data-principal-mapping.sql).
 *
 * Everything here talks to the real tables through the real least-privilege
 * `dpdp_app` role via the real `runWithTenant` helper (harness.ts) — the same
 * path the app itself uses. No mocks, no application-layer shortcuts: if RLS
 * or a CHECK/UNIQUE constraint were ever weakened, these tests fail against
 * the live schema, not a stand-in for it.
 */
describe('Storage & Folder Mapping — isolation, persistence, Gateway-independence', () => {
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

  async function createRoot(tenantId: string, name: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_roots (name, provider, root_path) VALUES ($1, 'local', $2) RETURNING id`,
        [name, `C:\\CompanyData\\${name}`],
      );
      return rows[0]!.id;
    });
  }

  async function createFolder(
    tenantId: string,
    storageRootId: string,
    name: string,
    parentFolderId: string | null = null,
  ): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_folders (storage_root_id, parent_folder_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [storageRootId, parentFolderId, name],
      );
      return rows[0]!.id;
    });
  }

  async function setMapping(
    tenantId: string,
    moduleKey: string,
    entityId: string,
    folderId: string,
  ): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ($1, $2, $3) RETURNING id`,
        [moduleKey, entityId, folderId],
      );
      return rows[0]!.id;
    });
  }

  // --- 1/2. Root + folder creation, and hierarchy persists ------------------

  describe('storage roots and folders — creation and hierarchy persistence', () => {
    it('tenant A can create a storage root (test 1)', async () => {
      const rootId = await createRoot(A.id, `${A_MARKER}-root-${randomUUID().slice(0, 8)}`);
      expect(rootId).toBeTruthy();
    });

    it('tenant A can create logical folders, including nested ones (test 2)', async () => {
      const rootId = await createRoot(A.id, `${A_MARKER}-root-${randomUUID().slice(0, 8)}`);
      const customersId = await createFolder(A.id, rootId, 'Customers');
      const rudraId = await createFolder(A.id, rootId, 'Rudra Suthar', customersId);

      // Fresh query — a separate SELECT, not the INSERT's own RETURNING — so
      // this actually proves the hierarchy round-trips through PostgreSQL
      // (test 4: persists after "restarting the application", modelled here
      // as a brand-new query on a fresh tenant context).
      const persisted = await asTenant(pool, A.id, (c) =>
        c.query<{ id: string; parent_folder_id: string | null; name: string }>(
          'SELECT id, parent_folder_id, name FROM storage_folders WHERE id = $1',
          [rudraId],
        ),
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]!.parent_folder_id).toBe(customersId);
      expect(persisted.rows[0]!.name).toBe('Rudra Suthar');
    });
  });

  // --- 3. Cross-tenant isolation ---------------------------------------------

  describe('cross-tenant isolation (I3, R5) — tenant B cannot see tenant A\'s storage (test 3)', () => {
    let rootA: string;
    let folderA: string;
    let mappingA: string;

    beforeAll(async () => {
      rootA = await createRoot(A.id, `${A_MARKER}-isolation-root-${randomUUID().slice(0, 8)}`);
      folderA = await createFolder(A.id, rootA, `${A_MARKER}-folder`);
      mappingA = await setMapping(A.id, 'consent_form', randomUUID(), folderA);
    });

    it('an unscoped SELECT under tenant B sees zero of tenant A\'s roots/folders/mappings', async () => {
      const [roots, folders, mappings] = await asTenant(pool, B.id, async (c) => {
        const r = await c.query('SELECT * FROM storage_roots');
        const f = await c.query('SELECT * FROM storage_folders');
        const m = await c.query('SELECT * FROM storage_mappings');
        return [r.rows, f.rows, m.rows];
      });
      expect(roots.some((r: any) => r.id === rootA)).toBe(false);
      expect(folders.some((r: any) => r.id === folderA)).toBe(false);
      expect(mappings.some((r: any) => r.id === mappingA)).toBe(false);
    });

    it('a direct id lookup for tenant A\'s folder under tenant B\'s context returns nothing (RLS, not app filtering)', async () => {
      const byId = await asTenant(pool, B.id, (c) =>
        c.query('SELECT * FROM storage_folders WHERE id = $1', [folderA]),
      );
      expect(byId.rows).toHaveLength(0);
    });
  });

  // --- 5/6. Consent-form mapping — explicit choice, persists, retrievable ---

  describe('consent-form mapping — explicit, persisted, retrievable (tests 5, 6, 7, 8)', () => {
    let rootA: string;
    let folderX: string;

    beforeAll(async () => {
      rootA = await createRoot(A.id, `${A_MARKER}-mapping-root-${randomUUID().slice(0, 8)}`);
      folderX = await createFolder(A.id, rootA, 'Folder X');
    });

    it('a consent template maps to Folder X, and reloading retrieves it from PostgreSQL', async () => {
      const templateId = randomUUID();
      await setMapping(A.id, 'consent_form', templateId, folderX);

      // A fresh, independent query, exactly like the app re-fetching the
      // mapping after a page reload (test 6).
      const reloaded = await asTenant(pool, A.id, (c) =>
        c.query<{ folder_id: string }>(
          `SELECT folder_id FROM storage_mappings WHERE module_key = 'consent_form' AND entity_id = $1 AND status = 'active'`,
          [templateId],
        ),
      );
      expect(reloaded.rows).toHaveLength(1);
      expect(reloaded.rows[0]!.folder_id).toBe(folderX);
    });

    it('no mapping is created without an explicit folder_id/entity_id (NOT NULL, DB-enforced) (test 7)', async () => {
      await expect(
        asTenant(pool, A.id, (c) =>
          c.query(`INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('consent_form', $1, NULL)`, [
            randomUUID(),
          ]),
        ),
      ).rejects.toThrow(/null value in column "folder_id"|violates not-null constraint/i);

      await expect(
        asTenant(pool, A.id, (c) =>
          c.query(`INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('consent_form', NULL, $1)`, [
            folderX,
          ]),
        ),
      ).rejects.toThrow(/null value in column "entity_id"|violates not-null constraint/i);
    });

    it('no automatic/unknown module_key mapping exists — the allowlist is a DB CHECK, not app-trust (test 8)', async () => {
      await expect(setMapping(A.id, 'inventory_guessed', randomUUID(), folderX)).rejects.toThrow(
        /storage_mappings_module_key_check|violates check constraint/i,
      );
    });
  });

  // --- 9/10. Customer / data-principal association ---------------------------

  describe('customer (data-principal) folder association — module_key = "data_principal" (tests 9, 10)', () => {
    let rootA: string;
    let folderCustomers: string;

    beforeAll(async () => {
      rootA = await createRoot(A.id, `${A_MARKER}-customer-root-${randomUUID().slice(0, 8)}`);
      folderCustomers = await createFolder(A.id, rootA, 'Customers');
    });

    it('customer A can be associated with a logical folder', async () => {
      const customerId = randomUUID();
      const folderRudra = await createFolder(A.id, rootA, 'Rudra Suthar', folderCustomers);
      await setMapping(A.id, 'data_principal', customerId, folderRudra);

      const found = await asTenant(pool, A.id, (c) =>
        c.query<{ folder_id: string }>(
          `SELECT folder_id FROM storage_mappings WHERE module_key = 'data_principal' AND entity_id = $1`,
          [customerId],
        ),
      );
      expect(found.rows[0]!.folder_id).toBe(folderRudra);
    });

    it('two customers with the same display name do not collide — they are keyed by opaque entity_id, never by name', async () => {
      // Two different real-world people who happen to share a name. Nothing in
      // this table ever sees the name "Rudra Suthar" — only two distinct,
      // client-supplied entity_id values, each in its own folder.
      const customer1 = randomUUID();
      const customer2 = randomUUID();
      const folder1 = await createFolder(A.id, rootA, `Rudra Suthar (${customer1.slice(0, 8)})`, folderCustomers);
      const folder2 = await createFolder(A.id, rootA, `Rudra Suthar (${customer2.slice(0, 8)})`, folderCustomers);

      await setMapping(A.id, 'data_principal', customer1, folder1);
      await setMapping(A.id, 'data_principal', customer2, folder2);

      const rows = await asTenant(pool, A.id, (c) =>
        c.query<{ entity_id: string; folder_id: string }>(
          `SELECT entity_id, folder_id FROM storage_mappings WHERE module_key = 'data_principal' AND entity_id = ANY($1)`,
          [[customer1, customer2]],
        ),
      );
      expect(rows.rows).toHaveLength(2);
      const byEntity = Object.fromEntries(rows.rows.map((r) => [r.entity_id, r.folder_id]));
      expect(byEntity[customer1]).toBe(folder1);
      expect(byEntity[customer2]).toBe(folder2);
      expect(byEntity[customer1]).not.toBe(byEntity[customer2]);
    });

    it('re-mapping the SAME customer (same entity_id) is a conflict, not a silent duplicate', async () => {
      const customerId = randomUUID();
      const folderA = await createFolder(A.id, rootA, `Dup-${customerId.slice(0, 8)}-A`, folderCustomers);
      const folderB = await createFolder(A.id, rootA, `Dup-${customerId.slice(0, 8)}-B`, folderCustomers);
      await setMapping(A.id, 'data_principal', customerId, folderA);

      await expect(setMapping(A.id, 'data_principal', customerId, folderB)).rejects.toThrow(
        /storage_mappings_module_entity_uq|violates unique constraint/i,
      );
    });
  });

  // --- 11. No file content representable in this schema at all --------------

  describe('actual files never touch central PostgreSQL — structurally, not just by convention (test 11)', () => {
    it('storage_roots, storage_folders, and storage_mappings have no file/content/byte column', async () => {
      const forbidden = /file|content|byte|blob|document/i;
      const { rows } = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('storage_roots', 'storage_folders', 'storage_mappings')`,
      );
      const offenders = rows.filter((r) => forbidden.test(r.column_name));
      expect(offenders).toEqual([]);
    });
  });

  // --- 12/13. SaaS and Enterprise both work via provider='local', zero Gateway ----

  describe('provider="local" works for both SaaS and Enterprise plans, with zero Gateway involvement (tests 12, 13)', () => {
    async function assertLocalRootWorksWithNoGateway(tenantId: string, plan: 'saas' | 'enterprise'): Promise<void> {
      // A second installations row for this plan — seedTenant's own default
      // row already exists (enterprise/client_server); this represents
      // "this tenant is on plan X" for the purpose of this proof without
      // fighting that default row (installations has no one-per-tenant
      // constraint, see 1737003700000_installations.sql).
      await asTenant(pool, tenantId, (c) =>
        c.query(
          `INSERT INTO installations (plan, deployment_type, version)
           VALUES ($1, $2, '1.0.0-storage-test')`,
          [plan, plan === 'saas' ? 'hosted' : 'client_server'],
        ),
      );

      const rootId = await createRoot(tenantId, `${plan}-local-root-${randomUUID().slice(0, 8)}`);
      const folderId = await createFolder(tenantId, rootId, 'DPDP');

      const persisted = await asTenant(pool, tenantId, (c) =>
        c.query<{ provider: string; gateway_device_id: string | null }>(
          'SELECT provider, gateway_device_id FROM storage_roots WHERE id = $1',
          [rootId],
        ),
      );
      expect(persisted.rows[0]!.provider).toBe('local');
      expect(persisted.rows[0]!.gateway_device_id).toBeNull();
      expect(folderId).toBeTruthy();

      // No Gateway device exists for this tenant at all — provider='local'
      // never required one, never created one, never looked for one.
      const devices = await asTenant(pool, tenantId, (c) => c.query('SELECT id FROM gateway_devices'));
      expect(devices.rows).toHaveLength(0);
    }

    it('a SaaS-plan tenant can select/create a local folder with no Gateway device required or created', async () => {
      await assertLocalRootWorksWithNoGateway(A.id, 'saas');
    });

    it('an Enterprise-plan tenant can ALSO select/create a local folder with no Gateway device required or created', async () => {
      await assertLocalRootWorksWithNoGateway(B.id, 'enterprise');
    });
  });

  // --- Consent Form Builder simplification: field-level Additional Storage ---
  // (1737004500000_consent-form-field-simplification.sql widened
  // storage_mappings_module_key_check to add 'consent_form_field') ----------

  describe('field-level Additional Storage — module_key = "consent_form_field" (one field, one folder, tenant-isolated)', () => {
    let rootA: string;
    let folderA1: string;
    let folderA2: string;

    beforeAll(async () => {
      rootA = await createRoot(A.id, `${A_MARKER}-field-root-${randomUUID().slice(0, 8)}`);
      folderA1 = await createFolder(A.id, rootA, `Aadhaar-${randomUUID().slice(0, 8)}`);
      folderA2 = await createFolder(A.id, rootA, `PAN-${randomUUID().slice(0, 8)}`);
    });

    it('two different fields on the same template map to two different folders independently', async () => {
      const aadhaarFieldId = randomUUID();
      const panFieldId = randomUUID();
      await setMapping(A.id, 'consent_form_field', aadhaarFieldId, folderA1);
      await setMapping(A.id, 'consent_form_field', panFieldId, folderA2);

      const rows = await asTenant(pool, A.id, (c) =>
        c.query<{ entity_id: string; folder_id: string }>(
          `SELECT entity_id, folder_id FROM storage_mappings WHERE module_key = 'consent_form_field' AND entity_id = ANY($1)`,
          [[aadhaarFieldId, panFieldId]],
        ),
      );
      const byField = Object.fromEntries(rows.rows.map((r) => [r.entity_id, r.folder_id]));
      expect(byField[aadhaarFieldId]).toBe(folderA1);
      expect(byField[panFieldId]).toBe(folderA2);
      expect(byField[aadhaarFieldId]).not.toBe(byField[panFieldId]);
    });

    it('tenant B cannot see tenant A\'s field-level storage mappings', async () => {
      const fieldId = randomUUID();
      const mappingId = await setMapping(A.id, 'consent_form_field', fieldId, folderA1);

      const asB = await asTenant(pool, B.id, (c) =>
        c.query('SELECT * FROM storage_mappings WHERE id = $1', [mappingId]),
      );
      expect(asB.rows).toHaveLength(0);
    });
  });
});
