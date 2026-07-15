import type { Pool } from 'pg';
import { banner, getAppPool, withRawConnection } from './harness';

/**
 * Preconditions — the suite must verify its OWN premise before it can trust any
 * result. RLS is silently bypassed for superusers, roles with BYPASSRLS, and
 * (without FORCE) the table owner. If the isolation suite ran as such a role,
 * every "cross-tenant read returned nothing" would be a false green. These tests
 * make that impossible: if the premise is broken, CI fails here, loudly.
 */
describe('Seam S1 preconditions — the suite cannot pass vacuously', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getAppPool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('runs as a role that CANNOT bypass RLS (not superuser, not BYPASSRLS)', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    );
    const info = rows[0];
    if (!info || info.rolsuper || info.rolbypassrls) {
      throw new Error(
        banner(
          `The isolation suite is connected as "${info?.role ?? 'unknown'}".`,
          `rolsuper=${info?.rolsuper} rolbypassrls=${info?.rolbypassrls}`,
          'This role BYPASSES RLS — every isolation result would be a false green.',
          'Point APP_DATABASE_URL at the least-privilege dpdp_app role.',
        ),
      );
    }
    expect(info.rolsuper).toBe(false);
    expect(info.rolbypassrls).toBe(false);
  });

  it('every public table with a tenant_id has RLS ENABLED + FORCED + a policy', async () => {
    // Discovers tenant tables by structure, so a future migration that adds a
    // tenant table but forgets app.apply_tenant_rls() fails this test.
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{
        table_name: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        has_policy: boolean;
      }>(`
        SELECT c.relname AS table_name,
               c.relrowsecurity AS rls_enabled,
               c.relforcerowsecurity AS rls_forced,
               EXISTS (
                 SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname
               ) AS has_policy
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
          )
        ORDER BY c.relname
      `),
    );

    // Sanity: we must actually have found the seeded tenant tables.
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const unprotected = rows.filter((r) => !r.rls_enabled || !r.rls_forced || !r.has_policy);
    if (unprotected.length > 0) {
      throw new Error(
        banner(
          'One or more tenant tables are NOT fully RLS-protected:',
          ...unprotected.map(
            (r) =>
              `  ${r.table_name}: enabled=${r.rls_enabled} forced=${r.rls_forced} policy=${r.has_policy}`,
          ),
          'Every tenant table must call app.apply_tenant_rls() in its migration.',
        ),
      );
    }
    expect(unprotected).toHaveLength(0);
  });
});
