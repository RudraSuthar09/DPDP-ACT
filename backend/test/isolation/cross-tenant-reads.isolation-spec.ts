import type { Pool } from 'pg';
import {
  A_MARKER,
  B_MARKER,
  asTenant,
  assertNoLeak,
  getAppPool,
  makeFixture,
  seedTenant,
  withRawConnection,
  TENANT_TABLES,
  type Row,
  type TenantFixture,
} from './harness';

/**
 * Cross-tenant READ isolation (R5, NFR-SEC-05). Two tenants are seeded with
 * distinct rows. Acting as tenant A, we fire a battery of queries — plain,
 * deliberately malformed, SQL-injection-style, and via JOINs/subqueries/UNIONs —
 * and assert NONE of them return a single row belonging to tenant B. The
 * enforcement is the Postgres engine (RLS), never an application WHERE clause.
 */
describe('Cross-tenant READ isolation', () => {
  let pool: Pool;
  // Fixtures at module scope so tenant B's id is available when building the
  // data-driven attack cases below (evaluated before beforeAll runs).
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

  // --- Positive controls: prove isolation is SELECTIVE, not blanket-deny ------
  // (Guards against a false green where everything returns zero.)

  it('positive control: tenant A sees its OWN rows', async () => {
    const names = await asTenant(pool, A.id, async (c) =>
      (await c.query<Row>('SELECT name FROM inventory_categories')).rows.map((r) => r.name),
    );
    expect(names).toEqual(expect.arrayContaining(A.categoryNames));
    expect(names).toHaveLength(A.categoryNames.length);
  });

  it('positive control: tenant B sees its OWN rows', async () => {
    const names = await asTenant(pool, B.id, async (c) =>
      (await c.query<Row>('SELECT name FROM inventory_categories')).rows.map((r) => r.name),
    );
    expect(names).toEqual(expect.arrayContaining(B.categoryNames));
    expect(names).toHaveLength(B.categoryNames.length);
  });

  // --- The headline test: a forgotten WHERE clause still leaks nothing --------

  it('a FORGOTTEN WHERE clause returns zero cross-tenant rows (RLS, not app code)', async () => {
    const rows = await asTenant(pool, A.id, async (c) => {
      // A developer forgot `WHERE tenant_id = $1`. In a WHERE-clause-based design
      // this leaks every tenant's data. Here RLS silently contains it.
      const res = await c.query<Row>('SELECT id, tenant_id, name FROM inventory_categories');
      return res.rows;
    });
    assertNoLeak(rows, B.id, 'SELECT with no WHERE clause');
    // And it did return A's own rows — so the query itself worked.
    expect(rows).toHaveLength(A.categoryNames.length);
  });

  // --- Data-driven battery of malformed / hostile read attempts --------------

  interface AttackCase {
    label: string;
    sql: string;
    params?: unknown[];
  }

  const attacks: AttackCase[] = [
    {
      label: 'explicit cross-tenant filter WHERE tenant_id = <B>',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories WHERE tenant_id = $1',
      params: [B.id],
    },
    {
      label: 'WHERE 1=1 (tautology)',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories WHERE 1=1',
    },
    {
      label: 'WHERE true OR tenant_id IS NOT NULL',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories WHERE true OR tenant_id IS NOT NULL',
    },
    {
      label: 'ORDER BY / LIMIT ALL cannot widen visibility',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories ORDER BY created_at LIMIT ALL',
    },
    {
      label: 'subquery: tenant_id IN (SELECT id FROM organisations)',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories WHERE tenant_id IN (SELECT id FROM organisations)',
    },
    {
      label: 'subquery targeting B: tenant_id IN (SELECT id FROM organisations WHERE id = <B>)',
      sql: 'SELECT id, tenant_id, name FROM inventory_categories WHERE tenant_id IN (SELECT id FROM organisations WHERE id = $1)',
      params: [B.id],
    },
    {
      label: 'JOIN organisations ON tenant_id',
      sql: `SELECT ic.id, ic.tenant_id, ic.name, o.name AS org_name
            FROM inventory_categories ic
            JOIN organisations o ON o.id = ic.tenant_id`,
    },
    {
      label: 'CROSS JOIN cannot pull the other tenant’s org in',
      sql: `SELECT ic.id, ic.tenant_id, ic.name, o.name AS org_name
            FROM inventory_categories ic, organisations o`,
    },
    {
      label: 'UNION ALL with a branch explicitly selecting B',
      sql: `SELECT id, tenant_id, name FROM inventory_categories
            UNION ALL
            SELECT id, tenant_id, name FROM inventory_categories WHERE tenant_id = $1`,
      params: [B.id],
    },
    {
      label: 'CTE wrapping an unfiltered scan',
      sql: 'WITH all_rows AS (SELECT * FROM inventory_categories) SELECT id, tenant_id, name FROM all_rows',
    },
    {
      label: 'reading organisations directly by B’s id',
      sql: 'SELECT id, tenant_id, name FROM organisations WHERE id = $1',
      params: [B.id],
    },
    {
      label: 'reading consent_purposes unfiltered',
      sql: 'SELECT id, tenant_id, name FROM consent_purposes',
    },
  ];

  it.each(attacks)(
    'acting as tenant A, "$label" returns ZERO tenant-B rows',
    async ({ sql, params, label }) => {
      const rows = await asTenant(pool, A.id, async (c) => (await c.query<Row>(sql, params)).rows);
      assertNoLeak(rows, B.id, label);
    },
  );

  // --- SQL-injection-style attempts ------------------------------------------

  it('parameterised malicious value is inert AND cannot leak tenant B', async () => {
    // The value looks like an injection but, parameterised, is treated as data.
    const rows = await asTenant(
      pool,
      A.id,
      async (c) =>
        (
          await c.query<Row>(
            'SELECT id, tenant_id, name FROM inventory_categories WHERE name = $1',
            [`' OR '1'='1`],
          )
        ).rows,
    );
    expect(rows).toHaveLength(0); // no category is literally named that string
    assertNoLeak(rows, B.id, 'parameterised injection value');
  });

  it('string-concatenation injection (OR 1=1) is contained by RLS', async () => {
    // A DELIBERATELY VULNERABLE query — user input concatenated into SQL. The
    // injected `OR '1'='1'` defeats the intended name filter and selects every
    // row the session can see. RLS still limits that to tenant A.
    const userInput = `x' OR '1'='1`;
    const vulnerableSql = `SELECT id, tenant_id, name FROM inventory_categories WHERE name = '${userInput}'`;
    const rows = await asTenant(pool, A.id, async (c) => (await c.query<Row>(vulnerableSql)).rows);

    // The broken filter did widen the result to all of A's rows...
    expect(rows.length).toBeGreaterThan(0);
    // ...but not one belongs to tenant B.
    assertNoLeak(rows, B.id, "concatenation injection: name = 'x' OR '1'='1'");
  });

  it('string-concatenation injection specifically targeting B’s tenant_id leaks nothing', async () => {
    const userInput = `x' OR tenant_id = '${B.id}`;
    const vulnerableSql = `SELECT id, tenant_id, name FROM inventory_categories WHERE name = '${userInput}'`;
    const rows = await asTenant(pool, A.id, async (c) => (await c.query<Row>(vulnerableSql)).rows);
    assertNoLeak(rows, B.id, "concatenation injection targeting B: OR tenant_id = '<B>'");
  });

  // --- Existence / aggregate leakage -----------------------------------------

  it('COUNT(*) as tenant A never counts tenant B’s rows', async () => {
    const total = await asTenant(pool, A.id, async (c) =>
      Number(
        (await c.query<{ n: string }>('SELECT count(*) AS n FROM inventory_categories')).rows[0]?.n,
      ),
    );
    expect(total).toBe(A.categoryNames.length);
  });

  it('COUNT filtered to B’s tenant_id is zero (existence cannot leak)', async () => {
    const n = await asTenant(pool, A.id, async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*) AS n FROM inventory_categories WHERE tenant_id = $1',
            [B.id],
          )
        ).rows[0]?.n,
      ),
    );
    expect(n).toBe(0);
  });

  it('EXISTS() cannot even detect that tenant B has data', async () => {
    const exists = await asTenant(
      pool,
      A.id,
      async (c) =>
        (
          await c.query<{ e: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM inventory_categories WHERE tenant_id = $1) AS e',
            [B.id],
          )
        ).rows[0]?.e,
    );
    expect(exists).toBe(false);
  });

  // --- Fail-closed: no tenant context at all ---------------------------------

  it('with NO tenant GUC set, tenant tables return zero rows (fail closed)', async () => {
    const counts = await withRawConnection(pool, async (c) => {
      const out: Record<string, number> = {};
      for (const table of TENANT_TABLES) {
        const res = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        out[table] = Number(res.rows[0]?.n);
      }
      return out;
    });
    for (const table of TENANT_TABLES) {
      expect(counts[table]).toBe(0);
    }
  });

  it('a spoofed / non-existent tenant id sees nothing', async () => {
    const spoofed = '00000000-0000-0000-0000-000000000000';
    const rows = await asTenant(
      pool,
      spoofed,
      async (c) =>
        (await c.query<Row>('SELECT id, tenant_id, name FROM inventory_categories')).rows,
    );
    expect(rows).toHaveLength(0);
    assertNoLeak(rows, B.id, 'spoofed tenant id');
  });
});
