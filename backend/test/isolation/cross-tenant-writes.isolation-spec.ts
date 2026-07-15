import type { Pool } from 'pg';
import {
  A_MARKER,
  B_MARKER,
  asTenant,
  getAppPool,
  makeFixture,
  seedTenant,
  type Row,
  type TenantFixture,
} from './harness';

/**
 * Cross-tenant WRITE isolation. RLS's WITH CHECK must make it impossible for one
 * tenant to create, modify, or destroy another tenant's rows — even with a
 * forgotten WHERE clause. And hard deletes must be impossible at all (I4:
 * nothing is hard-deleted; dpdp_app has no DELETE grant).
 */
describe('Cross-tenant WRITE isolation', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);
  const B: TenantFixture = makeFixture(B_MARKER);

  const bCategoryCount = () =>
    asTenant(pool, B.id, async (c) =>
      Number(
        (await c.query<{ n: string }>('SELECT count(*) AS n FROM inventory_categories')).rows[0]?.n,
      ),
    );

  const bCategoryNames = () =>
    asTenant(pool, B.id, async (c) =>
      (await c.query<Row>('SELECT name FROM inventory_categories ORDER BY name')).rows.map(
        (r) => r.name,
      ),
    );

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
    await seedTenant(pool, B);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('cannot INSERT a row for another tenant (RLS WITH CHECK rejects it)', async () => {
    await expect(
      asTenant(pool, A.id, async (c) => {
        await c.query('INSERT INTO inventory_categories (tenant_id, name) VALUES ($1, $2)', [
          B.id,
          `${B_MARKER}-planted-by-A`,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    // B is untouched.
    expect(await bCategoryCount()).toBe(B.categoryNames.length);
  });

  it('an UPDATE explicitly targeting B’s rows touches zero rows', async () => {
    const rowCount = await asTenant(pool, A.id, async (c) => {
      const res = await c.query('UPDATE inventory_categories SET name = $1 WHERE tenant_id = $2', [
        'HIJACKED',
        B.id,
      ]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
    expect(await bCategoryNames()).toEqual([...B.categoryNames].sort());
  });

  it('a FORGOTTEN-WHERE UPDATE only affects the acting tenant’s rows', async () => {
    const rowCount = await asTenant(pool, A.id, async (c) => {
      // No WHERE: attempt to rewrite the whole table. RLS scopes it to A.
      const res = await c.query('UPDATE inventory_categories SET name = $1', [
        `${A_MARKER}-bulk-renamed`,
      ]);
      return res.rowCount;
    });
    expect(rowCount).toBe(A.categoryNames.length);

    // B's rows are still exactly as seeded.
    expect(await bCategoryNames()).toEqual([...B.categoryNames].sort());
  });

  it('cannot re-tenant a row: UPDATE ... SET tenant_id = <B> is rejected', async () => {
    await expect(
      asTenant(pool, A.id, async (c) => {
        await c.query('UPDATE inventory_categories SET tenant_id = $1', [B.id]);
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await bCategoryCount()).toBe(B.categoryNames.length);
  });

  it('hard DELETE is not permitted at all (I4 — no DELETE grant)', async () => {
    await expect(
      asTenant(pool, A.id, async (c) => {
        await c.query('DELETE FROM inventory_categories');
      }),
    ).rejects.toThrow(/permission denied/i);

    // Nothing was deleted, for either tenant.
    expect(await bCategoryCount()).toBe(B.categoryNames.length);
  });
});
