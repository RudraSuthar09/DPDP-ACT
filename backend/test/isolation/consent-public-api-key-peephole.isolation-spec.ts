import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { A_MARKER, B_MARKER, asTenant, banner, getAppPool, withRawConnection } from './harness';

/**
 * FR-CON-09 introduces the second pre-tenant peephole on the platform:
 * app.resolve_public_api_key(), the Consent SDK's "which tenant does this key
 * belong to?" lookup — the same chicken-and-egg problem app.resolve_login()
 * already solves (see identity-peephole.isolation-spec.ts), mirrored for a
 * key hash instead of an email.
 *
 * Unlike the login peephole, consent_api_keys is an ordinary RLS-protected
 * tenant table (dpdp_app has normal SELECT/INSERT/UPDATE on it, for the
 * staff-facing create/list/revoke endpoints) — there is no separate,
 * privilege-stripped directory table backing this one. So what this suite
 * pins is narrower and different in shape from the login peephole:
 *
 *   1. The function is exact-hash-match only — no enumeration, no pattern.
 *   2. A revoked key still resolves (with revoked_at populated) rather than
 *      returning nothing — that's a deliberate difference from resolve_login,
 *      so the caller can say "revoked" instead of a bare lookup failure.
 *   3. RLS still fully isolates the table itself: knowing a key/tenant id
 *      from the peephole buys a caller nothing against consent_api_keys.
 */
describe('Consent SDK — the public API key peephole is exactly as narrow as claimed', () => {
  let pool: Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let userA = '';
  let userB = '';
  let rawKeyA = '';
  let hashA = '';
  let keyIdA = '';
  let rawKeyRevoked = '';
  let hashRevoked = '';

  function mintKey(): { raw: string; hash: string } {
    const raw = `pc_live_${randomBytes(32).toString('base64url')}`;
    return { raw, hash: createHash('sha256').update(raw).digest('hex') };
  }

  beforeAll(async () => {
    pool = getAppPool();

    await asTenant(pool, tenantA, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
        tenantA,
        `${A_MARKER} Org`,
      ]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, full_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [tenantA, `a-${tenantA.slice(0, 8)}@tenant-a.example`, `${A_MARKER} Owner`, 'scrypt$32768$8$1$c2FsdA==$aGFzaA=='],
      );
      userA = rows[0]!.id;

      const key = mintKey();
      rawKeyA = key.raw;
      hashA = key.hash;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO consent_api_keys (key_hash, key_prefix, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [hashA, rawKeyA.slice(0, 12), `${A_MARKER} key`, userA],
      );
      keyIdA = inserted.rows[0]!.id;

      const revoked = mintKey();
      rawKeyRevoked = revoked.raw;
      hashRevoked = revoked.hash;
      await client.query(
        `INSERT INTO consent_api_keys (key_hash, key_prefix, label, created_by, revoked_at)
         VALUES ($1, $2, $3, $4, now())`,
        [hashRevoked, rawKeyRevoked.slice(0, 12), `${A_MARKER} revoked key`, userA],
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
        [tenantB, `b-${tenantB.slice(0, 8)}@tenant-b.example`, `${B_MARKER} Owner`, 'scrypt$32768$8$1$c2FsdA==$aGFzaA=='],
      );
      userB = rows[0]!.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  // --- 1. Exact match, no enumeration --------------------------------------

  it('resolves the correct tenant for an exact key hash', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ tenant_id: string; key_id: string; created_by: string; revoked_at: string | null }>(
        'SELECT * FROM app.resolve_public_api_key($1)',
        [hashA],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA);
    expect(rows[0]!.key_id).toBe(keyIdA);
    expect(rows[0]!.created_by).toBe(userA);
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('exposes exactly tenant_id, key_id, created_by, revoked_at — nothing else', async () => {
    // Pinned by name: adding key_hash (or anything else) to this function's
    // return would hand hashed credential material to a pre-auth caller.
    const { fields } = await withRawConnection(pool, (c) =>
      c.query('SELECT * FROM app.resolve_public_api_key($1)', [hashA]),
    );
    expect(fields.map((f) => f.name).sort()).toEqual(
      ['created_by', 'key_id', 'revoked_at', 'tenant_id'].sort(),
    );
  });

  it('returns nothing for an unknown or malformed hash', async () => {
    for (const attempt of ['0'.repeat(64), 'not-a-hash', '', "' OR 1=1 --"]) {
      const { rows } = await withRawConnection(pool, (c) =>
        c.query('SELECT * FROM app.resolve_public_api_key($1)', [attempt]),
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('cannot be used to enumerate: a wildcard matches no hash', async () => {
    for (const attempt of ['%', '%pc_live%', hashA.slice(0, 10) + '%']) {
      const { rows } = await withRawConnection(pool, (c) =>
        c.query('SELECT * FROM app.resolve_public_api_key($1)', [attempt]),
      );
      expect(rows).toHaveLength(0);
    }
  });

  // --- 2. Revocation is reported, not hidden -------------------------------

  it('a revoked key still resolves, with revoked_at populated', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ tenant_id: string; revoked_at: string | null }>(
        'SELECT * FROM app.resolve_public_api_key($1)',
        [hashRevoked],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  // --- 3. RLS still fully isolates the table the peephole points into ------

  it("tenant B cannot read tenant A's key row even knowing the exact key id", async () => {
    const rows = await asTenant(pool, tenantB, async (client) => {
      const result = await client.query('SELECT id, key_hash, label FROM consent_api_keys WHERE id = $1', [
        keyIdA,
      ]);
      return result.rows;
    });
    if (rows.length > 0) {
      throw new Error(
        banner(
          "Tenant B read tenant A's consent_api_keys row by id.",
          `Leaked: ${JSON.stringify(rows)}`,
          'The public-key peephole is only safe because RLS backstops the table it points into. It does not.',
        ),
      );
    }
    expect(rows).toEqual([]);
  });

  it('tenant B cannot see tenant A keys with a forgotten WHERE clause', async () => {
    const rows = await asTenant(pool, tenantB, async (client) => {
      const result = await client.query<{ label: string }>('SELECT label FROM consent_api_keys');
      return result.rows;
    });
    expect(rows.map((r) => r.label)).toEqual([]);
  });

  it('tenant B cannot revoke (or otherwise mutate) a key it cannot see', async () => {
    await expect(
      asTenant(pool, tenantB, (client) =>
        client.query('UPDATE consent_api_keys SET revoked_at = now() WHERE id = $1', [keyIdA]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    // And the key still works afterwards — the no-op UPDATE did not revoke it.
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ revoked_at: string | null }>('SELECT * FROM app.resolve_public_api_key($1)', [hashA]),
    );
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('keys cannot be hard-deleted — no DELETE grant (platform rule, I4)', async () => {
    const has = await withRawConnection(pool, async (c) => {
      const { rows } = await c.query<{ has: boolean }>(
        `SELECT has_table_privilege(current_user, 'public.consent_api_keys', 'DELETE') AS has`,
      );
      return rows[0]!.has;
    });
    expect(has).toBe(false);
  });
});
