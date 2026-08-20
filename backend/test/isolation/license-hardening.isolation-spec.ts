import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * License hardening (locked-architecture license model follow-up):
 *   B. one active license per tenant, DB-enforced (licenses_one_active_per_tenant).
 *   C. a license cannot reference an installation belonging to a different
 *      tenant, DB-enforced (licenses_installation_tenant_consistency).
 *
 * `licenses` is deliberately not in harness.ts's TENANT_TABLES/seedTenant (it
 * has a hard NOT NULL FK to users.id via created_by) — this spec creates its
 * own minimal user fixture per tenant instead, directly, the same way
 * seedTenant creates its own installations row.
 */
describe('License hardening — DB-level constraints', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);
  const B: TenantFixture = makeFixture(B_MARKER);
  let userA: string;
  let userB: string;
  let installationA: string;
  let installationB: string;

  async function insertUser(tenantId: string, marker: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, full_name, password_hash)
         VALUES ($1, $2, $3, 'not-a-real-hash')
         RETURNING id`,
        [tenantId, `${marker.toLowerCase()}-${randomUUID().slice(0, 8)}@license-hardening.invalid`, marker],
      );
      return rows[0]!.id;
    });
  }

  async function insertLicense(
    tenantId: string,
    createdBy: string,
    opts: { status?: string; installationId?: string | null } = {},
  ): Promise<string> {
    const { status = 'pending', installationId = null } = opts;
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO licenses (plan, deployment_type, installation_id, license_key_hash, license_key_prefix, status, created_by)
         VALUES ('enterprise', 'client_server', $1, $2, 'TEST', $3, $4)
         RETURNING id`,
        [installationId, `hash-${randomUUID()}`, status, createdBy],
      );
      return rows[0]!.id;
    });
  }

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
    await seedTenant(pool, B);
    userA = await insertUser(A.id, A_MARKER);
    userB = await insertUser(B.id, B_MARKER);
    installationA = await asTenant(pool, A.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM installations WHERE tenant_id = $1 LIMIT 1`, [A.id]);
      return rows[0]!.id;
    });
    installationB = await asTenant(pool, B.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM installations WHERE tenant_id = $1 LIMIT 1`, [B.id]);
      return rows[0]!.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('B. one active license per tenant', () => {
    it('a second ACTIVE license for the same tenant is rejected by the database', async () => {
      await insertLicense(A.id, userA, { status: 'active' });

      await expect(insertLicense(A.id, userA, { status: 'active' })).rejects.toThrow(
        /licenses_one_active_per_tenant|duplicate key value violates unique constraint/i,
      );
    });

    it('a second license for the same tenant IS allowed when not active (pending/revoked coexist fine)', async () => {
      await expect(insertLicense(A.id, userA, { status: 'pending' })).resolves.toBeTruthy();
      await expect(insertLicense(A.id, userA, { status: 'revoked' })).resolves.toBeTruthy();
    });

    it('two DIFFERENT tenants can each have their own active license (the constraint is per-tenant, not global)', async () => {
      await expect(insertLicense(B.id, userB, { status: 'active' })).resolves.toBeTruthy();
    });
  });

  describe('C. license/installation tenant consistency', () => {
    it('a license cannot be created referencing another tenant’s installation', async () => {
      await expect(
        insertLicense(A.id, userA, { status: 'pending', installationId: installationB }),
      ).rejects.toThrow(/licenses_installation_tenant_consistency|violates foreign key constraint/i);
    });

    it('a license CAN reference its own tenant’s installation', async () => {
      await expect(
        insertLicense(A.id, userA, { status: 'pending', installationId: installationA }),
      ).resolves.toBeTruthy();
    });

    it('a pending license with NO installation yet (NULL) is still allowed (MATCH SIMPLE unaffected)', async () => {
      await expect(insertLicense(B.id, userB, { status: 'pending', installationId: null })).resolves.toBeTruthy();
    });

    it('re-pointing an existing license to another tenant’s installation via UPDATE is also rejected', async () => {
      const licenseId = await insertLicense(A.id, userA, { status: 'pending' });
      await expect(
        asTenant(pool, A.id, (c) =>
          c.query('UPDATE licenses SET installation_id = $2 WHERE id = $1', [licenseId, installationB]),
        ),
      ).rejects.toThrow(/licenses_installation_tenant_consistency|violates foreign key constraint/i);
    });
  });

  describe('11. a license cannot be activated twice (LicensingRepository.activate’s WHERE status = \'pending\' guard, unmodified by this change)', () => {
    // A fresh, dedicated tenant: A/B above accumulate active licenses across
    // earlier tests in this file (that's constraint B working correctly), and
    // reusing either here would collide with licenses_one_active_per_tenant
    // for an unrelated reason. This test is about the activate() guard only.
    const C: TenantFixture = makeFixture('TENANT-C-DOUBLE-ACTIVATE');
    let userC: string;
    let installationC: string;
    let otherInstallationForC: string;

    beforeAll(async () => {
      await seedTenant(pool, C);
      userC = await insertUser(C.id, 'TENANT-C');
      installationC = await asTenant(pool, C.id, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `SELECT id FROM installations WHERE tenant_id = $1 LIMIT 1`,
          [C.id],
        );
        return rows[0]!.id;
      });
      // A second installation for the SAME tenant C, so the "second activate
      // tries to rebind" step below stays within C's own tenant (this test is
      // about the activate() guard, not about constraint C).
      otherInstallationForC = await asTenant(pool, C.id, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO installations (tenant_id, plan, deployment_type, version)
           VALUES ($1, 'enterprise', 'client_server', '1.0.0-test-2') RETURNING id`,
          [C.id],
        );
        return rows[0]!.id;
      });
    });

    it('a second activate() attempt on an already-active license is a no-op, not a rebind', async () => {
      const licenseId = await insertLicense(C.id, userC, { status: 'pending' });

      const firstActivate = await asTenant(pool, C.id, (c) =>
        c.query(
          `UPDATE licenses SET status = 'active', installation_id = $2, activated_at = now()
             WHERE id = $1 AND status = 'pending' RETURNING id`,
          [licenseId, installationC],
        ),
      );
      expect(firstActivate.rowCount).toBe(1);

      // Same exact statement LicensingRepository.activate() runs. Attempting to
      // "activate" it again (e.g. a second POST /installations with the same
      // key) must touch ZERO rows -- the license is no longer 'pending'.
      const secondActivate = await asTenant(pool, C.id, (c) =>
        c.query(
          `UPDATE licenses SET status = 'active', installation_id = $2, activated_at = now()
             WHERE id = $1 AND status = 'pending' RETURNING id`,
          [licenseId, otherInstallationForC],
        ),
      );
      expect(secondActivate.rowCount).toBe(0);

      // Confirm it is still bound to its ORIGINAL installation, not silently
      // rebound to the second call's argument.
      const current = await asTenant(pool, C.id, (c) =>
        c.query<{ installation_id: string }>('SELECT installation_id FROM licenses WHERE id = $1', [licenseId]),
      );
      expect(current.rows[0]!.installation_id).toBe(installationC);
    });
  });
});
