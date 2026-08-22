import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * The customer/data-principal identity registry (1737004700000_data-principals.sql)
 * — fixes the real runtime bug where the 64-character subject_ref hash was
 * being passed straight into storage_mappings.entity_id (a uuid column).
 * This table is the missing piece: subject_ref (external, deterministic,
 * SubjectRefHasher, I2, unchanged) resolves to a stable INTERNAL customer_id
 * UUID via an atomic upsert — same subject_ref always yields the same id,
 * different subject_refs always yield different ids, and it never leaves
 * its own tenant.
 */
describe('data_principals — the customer/data-principal identity registry', () => {
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

  async function resolveOrCreate(tenantId: string, subjectRef: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO data_principals (subject_ref) VALUES ($1)
         ON CONFLICT ON CONSTRAINT data_principals_tenant_subject_uq
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [subjectRef],
      );
      return rows[0]!.id;
    });
  }

  it('resolves a fresh subject_ref to a real UUID (never the subject_ref itself)', async () => {
    const subjectRef = randomUUID().repeat(2); // a long, non-UUID-shaped string, like a real HMAC hex digest
    const customerId = await resolveOrCreate(A.id, subjectRef);
    expect(customerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(customerId).not.toBe(subjectRef);
  });

  it('the SAME subject_ref always resolves to the SAME customer_id — repeat submissions reuse one identity', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const first = await resolveOrCreate(A.id, subjectRef);
    const second = await resolveOrCreate(A.id, subjectRef);
    const third = await resolveOrCreate(A.id, subjectRef);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('two DIFFERENT subject_refs always resolve to DIFFERENT customer_ids — no accidental merging', async () => {
    const refA = `subj-${randomUUID()}`;
    const refB = `subj-${randomUUID()}`;
    const idA = await resolveOrCreate(A.id, refA);
    const idB = await resolveOrCreate(A.id, refB);
    expect(idA).not.toBe(idB);
  });

  it('tenant B cannot see tenant A\'s data_principals row', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const customerId = await resolveOrCreate(A.id, subjectRef);
    const asB = await asTenant(pool, B.id, (c) => c.query('SELECT * FROM data_principals WHERE id = $1', [customerId]));
    expect(asB.rows).toHaveLength(0);
  });

  it('the SAME subject_ref string in DIFFERENT tenants resolves to DIFFERENT customer_ids — the registry is per-tenant, not global', async () => {
    const subjectRef = `subj-${randomUUID()}`; // same literal string, two tenants
    const idA = await resolveOrCreate(A.id, subjectRef);
    const idB = await resolveOrCreate(B.id, subjectRef);
    expect(idA).not.toBe(idB);
  });

  it('the resolved customer_id is a valid storage_mappings.entity_id — closes the loop the runtime bug broke', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const customerId = await resolveOrCreate(A.id, subjectRef);

    const rootId = await asTenant(pool, A.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_roots (name, provider) VALUES ($1, 'local') RETURNING id`,
        [`${A_MARKER}-registry-root-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
    const folderId = await asTenant(pool, A.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_folders (storage_root_id, name) VALUES ($1, $2) RETURNING id`,
        [rootId, `Customer-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });

    // This is EXACTLY the INSERT that used to throw
    // "invalid input syntax for type uuid" when entityId was subject_ref.
    const mapping = await asTenant(pool, A.id, (c) =>
      c.query(
        `INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('data_principal', $1, $2) RETURNING id`,
        [customerId, folderId],
      ),
    );
    expect(mapping.rows).toHaveLength(1);
  });

  it('the same 64-character subject_ref shape that triggered the original bug is REJECTED as entity_id, even under DATABASE_URL-level access (structural proof, not just app-layer validation)', async () => {
    const fakeHmacHex = '301b34d8a445a51bdeb536e861dc0281beb1e325958368f992819801ef6559a3'; // the exact value from the bug report
    const rootId = await asTenant(pool, A.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_roots (name, provider) VALUES ($1, 'local') RETURNING id`,
        [`${A_MARKER}-reject-root-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
    const folderId = await asTenant(pool, A.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO storage_folders (storage_root_id, name) VALUES ($1, $2) RETURNING id`,
        [rootId, `Folder-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
    await expect(
      asTenant(pool, A.id, (c) =>
        c.query(`INSERT INTO storage_mappings (module_key, entity_id, folder_id) VALUES ('data_principal', $1, $2)`, [
          fakeHmacHex,
          folderId,
        ]),
      ),
    ).rejects.toThrow(/invalid input syntax for type uuid/i);
  });
});
