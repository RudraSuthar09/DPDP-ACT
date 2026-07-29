import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { asTenant, banner, getAppPool, withRawConnection } from './harness';

/**
 * Seam S5 against a real Postgres: the chain links, the log cannot be edited,
 * and the verifier finds any break.
 *
 * These run in the isolation suite (not the unit suite) because every property
 * here is a property of the DATABASE — the grants, the triggers, the hash
 * arithmetic. A mocked version of this file would test nothing: it would assert
 * that a fake refuses what we told it to refuse.
 */
describe('Seam S5 — the audit chain', () => {
  let pool: Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let userA = '';

  const append = (client: PoolClient, action: string, extra: Record<string, unknown> = {}) =>
    client.query<{ entry_id: string; entry_seq: string; entry_hash: Buffer }>(
      `SELECT entry_id, entry_seq, entry_hash
         FROM app.audit_append($1, $2, $3, $4, NULL, 'user', $5, $6, NULL, NULL, $7, 'isolation-suite')`,
      [
        action,
        extra.outcome ?? 'success',
        randomUUID(),
        extra.actorId ?? userA,
        extra.targetId ?? userA,
        extra.reason ?? 'because the test said so',
        extra.ip ?? '203.0.113.10',
      ],
    );

  beforeAll(async () => {
    pool = getAppPool();
    await asTenant(pool, tenantA, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1,$1,$2)', [
        tenantA,
        'Audit Tenant A',
      ]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, full_name, password_hash, role)
         VALUES ($1, $2, 'Audit Owner', 'scrypt$32768$8$1$c2FsdA==$aGFzaA==', 'owner')
         RETURNING id`,
        [tenantA, `audit-${tenantA.slice(0, 8)}@a.example`],
      );
      userA = rows[0]!.id;
    });
    await asTenant(pool, tenantB, (client) =>
      client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1,$1,$2)', [
        tenantB,
        'Audit Tenant B',
      ]),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  // --- the write path is the only write path -------------------------------

  it('dpdp_app can SELECT audit_log and do NOTHING else to it', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ priv: string; has: boolean }>(`
        SELECT p.priv, has_table_privilege(current_user, 'public.audit_log', p.priv) AS has
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS p(priv)
      `),
    );
    const granted = rows.filter((r) => r.has).map((r) => r.priv);
    if (granted.join(',') !== 'SELECT') {
      throw new Error(
        banner(
          `dpdp_app holds ${granted.join(', ') || 'no privileges'} on audit_log; expected SELECT only.`,
          'An INSERT grant would let any service — or any SQL injection — write its',
          'own history. The one write path is app.audit_append(), used by the one',
          'interceptor (R3).',
        ),
      );
    }
    expect(granted).toEqual(['SELECT']);
  });

  it.each([
    [
      'INSERT',
      `INSERT INTO audit_log (tenant_id, seq, action, outcome, correlation_id, prev_hash, hash)
       VALUES (gen_random_uuid(), 1, 'forged', 'success', gen_random_uuid(),
               '\\x0000000000000000000000000000000000000000000000000000000000000000',
               '\\x0000000000000000000000000000000000000000000000000000000000000000')`,
    ],
    ['UPDATE', `UPDATE audit_log SET action = 'rewritten'`],
    ['DELETE', `DELETE FROM audit_log`],
    ['TRUNCATE', `TRUNCATE audit_log`],
  ])('the app role cannot %s audit_log', async (_verb, sql) => {
    await expect(asTenant(pool, tenantA, (client) => client.query(sql))).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  // --- the chain -----------------------------------------------------------

  it('links each entry to the one before it, starting from genesis', async () => {
    await asTenant(pool, tenantA, async (client) => {
      await append(client, 'test.first');
      await append(client, 'test.second');
      await append(client, 'test.third');
    });

    const chain = await asTenant(pool, tenantA, async (client) => {
      const { rows } = await client.query<{ seq: string; prev: string; hash: string }>(
        `SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS hash
           FROM audit_log ORDER BY seq`,
      );
      return rows;
    });

    expect(chain).toHaveLength(3);
    expect(chain.map((c) => Number(c.seq))).toEqual([1, 2, 3]);
    expect(chain[0]!.prev).toMatch(/^0{64}$/); // genesis
    expect(chain[1]!.prev).toBe(chain[0]!.hash);
    expect(chain[2]!.prev).toBe(chain[1]!.hash);
    // Every hash is distinct: identical actions still chain to different places.
    expect(new Set(chain.map((c) => c.hash)).size).toBe(3);
  });

  it('ignores seq/prev_hash/hash the caller tries to supply — the DB owns the chain', async () => {
    // app.audit_append does not even accept them as parameters. This asserts the
    // consequence: an appended entry always continues the real chain, never a
    // caller's idea of it.
    const before = await asTenant(pool, tenantA, async (client) => {
      const { rows } = await client.query<{ hash: string }>(
        `SELECT encode(hash,'hex') AS hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
      );
      return rows[0]!.hash;
    });
    const appended = await asTenant(pool, tenantA, async (client) => {
      const { rows } = await append(client, 'test.cannot_forge');
      const { rows: stored } = await client.query<{ prev: string }>(
        `SELECT encode(prev_hash,'hex') AS prev FROM audit_log WHERE id = $1`,
        [rows[0]!.entry_id],
      );
      return stored[0]!.prev;
    });
    expect(appended).toBe(before);
  });

  it('verify_audit_chain reports nothing on an intact chain', async () => {
    const breaks = await asTenant(pool, tenantA, async (client) => {
      const { rows } = await client.query('SELECT * FROM app.verify_audit_chain()');
      return rows;
    });
    expect(breaks).toEqual([]);
  });

  // --- tamper detection ----------------------------------------------------
  //
  // The app role cannot edit the log at all, so to prove the CHAIN (rather than
  // the grants) detects tampering, these tests reach past the application the
  // way an attacker with database rights would.

  it('detects an altered entry', async () => {
    const owner = await ownerConnection(tenantA);
    try {
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      await owner.query(
        `UPDATE audit_log SET reason = 'a quiet edit' WHERE tenant_id = $1 AND seq = 2`,
        [tenantA],
      );
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

      const breaks = await verify(tenantA);
      expect(breaks.some((b) => b.entry_seq === '2' && /altered entry/.test(b.problem))).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it('detects the cover-up: repairing the edited hash just moves the break forward', async () => {
    // The interesting property. An attacker who edits an entry and recomputes
    // ITS hash has not fixed anything — entry 3 still commits to the old hash of
    // entry 2, so the break walks toward the head. To hide the edit they must
    // rewrite every entry after it, all the way to the newest.
    const owner = await ownerConnection(tenantA);
    try {
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      await owner.query(
        `UPDATE audit_log SET hash = app.audit_entry_hash(prev_hash, tenant_id, seq, occurred_at,
             actor_id, actor_label, action, outcome, target_type, target_id, reason,
             before_state, after_state, source_ip, user_agent, correlation_id)
         WHERE tenant_id = $1 AND seq = 2`,
        [tenantA],
      );
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

      const breaks = await verify(tenantA);
      expect(breaks.some((b) => b.entry_seq === '2' && /altered entry/.test(b.problem))).toBe(
        false,
      );
      expect(breaks.some((b) => b.entry_seq === '3' && /broken link/.test(b.problem))).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it('detects a removed entry as a sequence gap', async () => {
    const owner = await ownerConnection(tenantA);
    try {
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      await owner.query(`DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 2`, [tenantA]);
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

      const breaks = await verify(tenantA);
      expect(breaks.some((b) => /sequence gap/.test(b.problem))).toBe(true);
    } finally {
      await owner.end();
    }
  });

  // --- isolation -----------------------------------------------------------

  it('one tenant cannot read another tenant audit log', async () => {
    const seen = await asTenant(pool, tenantB, async (client) => {
      const { rows } = await client.query('SELECT * FROM audit_log');
      return rows;
    });
    if (seen.length > 0) {
      throw new Error(
        banner(
          `Tenant B read ${seen.length} of tenant A's audit entries.`,
          'The audit log records who did what and from which IP. A leak here is a',
          "disclosure of another client's staff activity.",
        ),
      );
    }
    expect(seen).toEqual([]);
  });

  it('each tenant has its OWN chain, starting at its own genesis', async () => {
    const b = await asTenant(pool, tenantB, async (client) => {
      await client.query(`SELECT * FROM app.audit_append('test.b.first','success',$1)`, [
        randomUUID(),
      ]);
      const { rows } = await client.query<{ seq: string; prev: string }>(
        `SELECT seq, encode(prev_hash,'hex') AS prev FROM audit_log ORDER BY seq`,
      );
      return rows;
    });
    // Tenant A already has several entries; B's first is still seq 1 from
    // genesis. A global chain would make each tenant's history depend on rows
    // they are not allowed to see — and so unverifiable by the only party who
    // needs to verify it.
    expect(b).toHaveLength(1);
    expect(Number(b[0]!.seq)).toBe(1);
    expect(b[0]!.prev).toMatch(/^0{64}$/);
  });

  it('verifies one tenant chain without seeing, or vouching for, the other', async () => {
    // Tenant A's chain is broken by the tests above; B's is intact. B's verify
    // must come back clean — the verifier runs under RLS, not over the table.
    expect(await verify(tenantB)).toEqual([]);
    expect((await verify(tenantA)).length).toBeGreaterThan(0);
  });

  it('cannot append into another tenant chain — audit_append takes no tenant', async () => {
    const entry = await asTenant(pool, tenantB, async (client) => {
      const { rows } = await client.query<{ entry_id: string }>(
        `SELECT entry_id FROM app.audit_append('test.b.second','success',$1)`,
        [randomUUID()],
      );
      return rows[0]!.entry_id;
    });
    const visibleToB = await asTenant(pool, tenantB, async (client) => {
      const { rows } = await client.query('SELECT id FROM audit_log WHERE id = $1', [entry]);
      return rows.length;
    });
    expect(visibleToB).toBe(1);
  });

  it('fails closed with no tenant bound', async () => {
    // audit_log's tenant_id is `NOT NULL DEFAULT app.current_tenant()`, so the
    // natural guess is a not-null violation when the GUC is unset. That is not
    // what Postgres actually raises here: FORCE ROW LEVEL SECURITY means the
    // tenant_isolation policy's WITH CHECK (`tenant_id = app.current_tenant()`)
    // is evaluated on the row being inserted, and three-valued SQL logic makes
    // `NULL = NULL` neither true nor false — so RLS refuses the row (42501)
    // before the NOT NULL constraint is ever reached. Confirmed empirically
    // against the live database, not assumed. Either error means the same
    // thing operationally — no row is written — so both patterns are accepted;
    // what actually matters is that it throws at all.
    await expect(
      withRawConnection(pool, (c) =>
        c.query(`SELECT * FROM app.audit_append('test.no_tenant','success',$1)`, [randomUUID()]),
      ),
    ).rejects.toThrow(/row-level security|null value|not-null/i);
  });

  async function verify(tenant: string): Promise<{ entry_seq: string; problem: string }[]> {
    return asTenant(pool, tenant, async (client) => {
      const { rows } = await client.query<{ entry_seq: string; problem: string }>(
        'SELECT entry_seq, problem FROM app.verify_audit_chain()',
      );
      return rows;
    });
  }
});

/**
 * A connection as the migration/owner role. Used ONLY to simulate an attacker
 * who has gone around the application — which is the only way to tamper at all,
 * and therefore the only way to test that tampering is caught.
 *
 * `audit_log` has FORCE ROW LEVEL SECURITY — set deliberately so that even the
 * table owner is bound by the tenant_isolation policy (defense in depth against
 * ever running app queries as the owner; see the migration header). That means
 * this connection, with no `app.current_tenant` GUC set, is not "unrestricted
 * database access" the way an owner connection normally would be: the
 * tenant_isolation policy's USING clause filters the tamper UPDATE/DELETE below
 * to zero matching rows, and Postgres reports that as an ordinary zero-row
 * result — NOT an error — so a test that skipped this step would silently tamper
 * with nothing and still "pass" the surrounding try/finally.
 *
 * A real attacker with database rights, targeting a SPECIFIC known tenant's
 * chain, would simply set this GUC themselves — it is exactly what the
 * production `runWithTenant` helper does for a legitimate request, and nothing
 * stops an owner-level connection from issuing the same `set_config` call. So
 * we do the same, deliberately, to reach row(s) the way that attacker would —
 * this is scoping the attack to one tenant, not weakening what RLS enforces.
 */
async function ownerConnection(tenantId: string): Promise<PoolClient & { end: () => Promise<void> }> {
  const { Client } = await import('pg');
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL (owner role) is required for the audit tamper tests.');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  // Session-scoped (is_local=false, unlike runWithTenant's transaction-scoped
  // `true`): these tests issue several sequential statements on one connection
  // with no explicit BEGIN wrapping them, and the whole connection is closed
  // (client.end()) in the test's `finally`, so there is nothing to leak.
  await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant', tenantId]);
  return client as unknown as PoolClient & { end: () => Promise<void> };
}
