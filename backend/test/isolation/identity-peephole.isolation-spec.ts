import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { A_MARKER, B_MARKER, asTenant, banner, getAppPool, withRawConnection } from './harness';

/**
 * The identity module introduces the ONE deliberate exception to "every table is
 * tenant-scoped": `app.user_directory`, the email → tenant lookup that login
 * cannot work without (there is no JWT yet at login, so there is no tenant to
 * bind — see the identity migration header).
 *
 * An exception to the platform's central invariant does not get to live on a
 * comment and good intentions. This suite pins its exact shape:
 *
 *   1. dpdp_app cannot read, write, or enumerate the directory. At all.
 *   2. The only way in is app.resolve_login(), which takes an exact email and
 *      returns three ids — no credential material, no listing.
 *   3. Knowing another tenant's user id (which resolve_login could reveal) still
 *      buys an attacker nothing: RLS stops them at the users table.
 *   4. Users cannot be hard-deleted, because the grant does not exist.
 *
 * If a future migration widens any of this, CI fails here.
 */
describe('Identity — the login peephole is exactly as narrow as claimed', () => {
  let pool: Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const emailA = `a-${tenantA.slice(0, 8)}@tenant-a.example`;
  const emailB = `b-${tenantB.slice(0, 8)}@tenant-b.example`;
  let userB = '';

  beforeAll(async () => {
    pool = getAppPool();

    await asTenant(pool, tenantA, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
        tenantA,
        `${A_MARKER} Org`,
      ]);
      await client.query(
        `INSERT INTO users (tenant_id, email, full_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner')`,
        [tenantA, emailA, `${A_MARKER} Owner`, 'scrypt$32768$8$1$c2FsdA==$aGFzaA=='],
      );
    });

    await asTenant(pool, tenantB, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
        tenantB,
        `${B_MARKER} Org`,
      ]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, full_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [tenantB, emailB, `${B_MARKER} Owner`, 'scrypt$32768$8$1$c2FsdA==$aGFzaA=='],
      );
      userB = rows[0]!.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  // --- 1. The directory is unreachable ------------------------------------

  it('dpdp_app holds NO privileges on app.user_directory', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ priv: string; has: boolean }>(`
        SELECT p.priv, has_table_privilege(current_user, 'app.user_directory', p.priv) AS has
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS p(priv)
      `),
    );
    const granted = rows.filter((r) => r.has).map((r) => r.priv);
    if (granted.length > 0) {
      throw new Error(
        banner(
          `dpdp_app has ${granted.join(', ')} on app.user_directory.`,
          'That table maps every email on the platform to its tenant. The app role',
          'must reach it ONLY through app.resolve_login() — a grant here turns the',
          'peephole into a window: any SQL injection could enumerate every client',
          'and every user on the platform.',
        ),
      );
    }
    expect(granted).toEqual([]);
  });

  it.each([
    ['SELECT * FROM app.user_directory'],
    ['SELECT email, tenant_id FROM app.user_directory'],
    // The enumeration an attacker actually wants: "who else is on this platform?"
    [`SELECT * FROM app.user_directory WHERE email LIKE '%@%'`],
    [
      `INSERT INTO app.user_directory (email, user_id, tenant_id, status)
      VALUES ('evil@evil.example', gen_random_uuid(), gen_random_uuid(), 'active')`,
    ],
    [`UPDATE app.user_directory SET tenant_id = gen_random_uuid()`],
    ['DELETE FROM app.user_directory'],
  ])('is refused direct access: %s', async (sql) => {
    await expect(withRawConnection(pool, (c) => c.query(sql))).rejects.toThrow(
      /permission denied/i,
    );
  });

  // --- 2. The function is the only way in, and it is narrow ---------------

  it('resolve_login returns the tenant binding for an exact email', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ tenant_id: string; status: string }>('SELECT * FROM app.resolve_login($1)', [
        emailA,
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA);
    expect(rows[0]!.status).toBe('active');
  });

  it('resolve_login is case-insensitive on the caller side', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query('SELECT * FROM app.resolve_login($1)', [emailA.toUpperCase()]),
    );
    expect(rows).toHaveLength(1);
  });

  it('resolve_login returns nothing for an unknown email', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query('SELECT * FROM app.resolve_login($1)', ['nobody@nowhere.example']),
    );
    expect(rows).toHaveLength(0);
  });

  it('resolve_login exposes NO credential material', async () => {
    const { fields } = await withRawConnection(pool, (c) =>
      c.query('SELECT * FROM app.resolve_login($1)', [emailA]),
    );
    // Pinned by name: adding password_hash or mfa_secret_ciphertext to this
    // function's return would hand every credential to a pre-auth caller.
    expect(fields.map((f) => f.name).sort()).toEqual(['status', 'tenant_id', 'user_id']);
  });

  it('cannot be used to enumerate: it takes an exact email, not a pattern', async () => {
    // A wildcard is just a string that matches no address.
    for (const attempt of ['%', '%@%', "' OR 1=1 --", '%tenant-b%']) {
      const { rows } = await withRawConnection(pool, (c) =>
        c.query('SELECT * FROM app.resolve_login($1)', [attempt]),
      );
      expect(rows).toHaveLength(0);
    }
  });

  // --- 3. Knowing the id buys nothing -------------------------------------

  it("tenant A cannot read tenant B's user even knowing the exact user id", async () => {
    // The worst case for the peephole: resolve_login told the attacker a user id
    // and a tenant id. This is where that stops being useful — RLS does not care
    // what you know, only which tenant is bound to the session.
    const rows = await asTenant(pool, tenantA, async (client) => {
      const result = await client.query(
        `SELECT id, email, password_hash FROM users WHERE id = $1`,
        [userB],
      );
      return result.rows;
    });
    if (rows.length > 0) {
      throw new Error(
        banner(
          "Tenant A read tenant B's user row by id.",
          `Leaked: ${JSON.stringify(rows)}`,
          'The login peephole is only safe because RLS backstops it. It does not.',
        ),
      );
    }
    expect(rows).toEqual([]);
  });

  it('tenant A cannot see tenant B users with a forgotten WHERE clause', async () => {
    const rows = await asTenant(pool, tenantA, async (client) => {
      const result = await client.query<{ email: string }>('SELECT email FROM users');
      return result.rows;
    });
    expect(rows.map((r) => r.email)).toEqual([emailA]);
  });

  it('tenant A cannot re-tenant a user into its own workspace', async () => {
    // The takeover attempt: claim another tenant's user by UPDATE.
    await expect(
      asTenant(pool, tenantA, (client) =>
        client.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [tenantA, userB]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('tenant A cannot insert a user into tenant B (WITH CHECK)', async () => {
    await expect(
      asTenant(pool, tenantA, (client) =>
        client.query(
          `INSERT INTO users (tenant_id, email, full_name, password_hash)
           VALUES ($1, $2, 'Intruder', 'x')`,
          [tenantB, `intruder-${randomUUID().slice(0, 8)}@evil.example`],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  // --- 4. Never hard-delete ------------------------------------------------

  it('users cannot be hard-deleted — there is no DELETE grant (platform rule, I4)', async () => {
    expect(
      await withRawConnection(pool, async (c) => {
        const { rows } = await c.query<{ has: boolean }>(
          `SELECT has_table_privilege(current_user, 'public.users', 'DELETE') AS has`,
        );
        return rows[0]!.has;
      }),
    ).toBe(false);

    // And in practice, not just on paper.
    await expect(
      asTenant(pool, tenantA, (client) => client.query('DELETE FROM users')),
    ).rejects.toThrow(/permission denied/i);
  });

  it.each(['user_recovery_codes', 'workspace_modules'])(
    'the identity table %s also has no DELETE grant',
    async (table) => {
      const has = await withRawConnection(pool, async (c) => {
        const { rows } = await c.query<{ has: boolean }>(
          `SELECT has_table_privilege(current_user, $1, 'DELETE') AS has`,
          [`public.${table}`],
        );
        return rows[0]!.has;
      });
      expect(has).toBe(false);
    },
  );

  // --- 5. The workspace is complete ---------------------------------------

  it('a provisioned workspace is invisible to another tenant (FR-IDN-01 isolation)', async () => {
    await asTenant(pool, tenantB, (client) =>
      client.query(
        `INSERT INTO workspace_modules (tenant_id, module)
         SELECT $1, unnest(ARRAY['inventory','consent','breach','grievance','dprequest'])`,
        [tenantB],
      ),
    );

    const seenByA = await asTenant(pool, tenantA, async (client) => {
      const { rows } = await client.query('SELECT module FROM workspace_modules');
      return rows;
    });
    expect(seenByA).toEqual([]);

    const seenByB = await asTenant(pool, tenantB, async (client) => {
      const { rows } = await client.query<{ module: string }>(
        'SELECT module FROM workspace_modules ORDER BY module',
      );
      return rows.map((r) => r.module);
    });
    expect(seenByB).toEqual(['breach', 'consent', 'dprequest', 'grievance', 'inventory']);
  });
});
