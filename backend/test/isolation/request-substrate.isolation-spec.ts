import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { A_MARKER, B_MARKER, asTenant, banner, getAppPool, withRawConnection } from './harness';

/**
 * The shared request substrate (FR-GRV-01/03/04/05) is the platform's first
 * genuinely PUBLIC, unauthenticated write surface, and it introduces the third
 * pre-tenant peephole: app.resolve_portal_slug().
 *
 * That combination is exactly the shape of thing R5 exists for, so this suite
 * pins four claims the rest of the design leans on:
 *
 *   1. The portal peephole is an exact-match lookup that returns a tenant id and
 *      a display name — and, unlike the API-key peephole, is deliberately NOT a
 *      credential check. What it must NOT be is an enumeration surface.
 *   2. Resolving a slug buys nothing. Knowing tenant A's slug AND tenant A's
 *      ticket id still gets tenant B nothing, because RLS is what contains the
 *      request tables — not the fact that the portal middleware "only" resolved
 *      one tenant.
 *   3. The append-only trails really are append-only, for the runtime role: the
 *      correspondence on a grievance cannot be quietly reworded or removed.
 *   4. Nothing in the substrate can be hard-deleted (I4).
 */
describe('Request substrate — public intake does not weaken tenant isolation', () => {
  let pool: Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let slugA = '';
  let ticketA = '';
  let correspondenceA = '';

  beforeAll(async () => {
    pool = getAppPool();

    await asTenant(pool, tenantA, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
        tenantA,
        `${A_MARKER} Org`,
      ]);
      const org = await client.query<{ portal_slug: string }>(
        'SELECT portal_slug FROM organisations WHERE id = $1',
        [tenantA],
      );
      slugA = org.rows[0]!.portal_slug;

      const ticket = await client.query<{ id: string }>(
        `INSERT INTO request_tickets
           (request_type, reference_code, subject, contact_channel, contact_value)
         VALUES ('grievance', $1, $2, 'email', $3) RETURNING id`,
        [`GRV-${tenantA.slice(0, 4).toUpperCase()}-AAAA`, `${A_MARKER} complaint`, 'a@tenant-a.example'],
      );
      ticketA = ticket.rows[0]!.id;

      const entry = await client.query<{ id: string }>(
        `INSERT INTO request_correspondence (ticket_id, direction, author_type, body)
         VALUES ($1, 'inbound', 'public_submitter', $2) RETURNING id`,
        [ticketA, `${A_MARKER} the complaint text`],
      );
      correspondenceA = entry.rows[0]!.id;
    });

    await asTenant(pool, tenantB, async (client) => {
      await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
        tenantB,
        `${B_MARKER} Org`,
      ]);
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  // --- 1. The peephole is narrow -------------------------------------------

  it('resolves an exact slug to its tenant and display name — and nothing else', async () => {
    const { rows, fields } = await withRawConnection(pool, (c) =>
      c.query<{ tenant_id: string; name: string }>('SELECT * FROM app.resolve_portal_slug($1)', [
        slugA,
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA);
    // Pinned by name: anything added to this function's return is handed to an
    // anonymous caller on a public page, forever.
    expect(fields.map((f) => f.name).sort()).toEqual(['name', 'tenant_id']);
  });

  it('cannot be used to enumerate tenants', async () => {
    for (const attempt of ['%', '%-%', slugA.slice(0, 5) + '%', '', "' OR 1=1 --", '_'.repeat(10)]) {
      const { rows } = await withRawConnection(pool, (c) =>
        c.query('SELECT * FROM app.resolve_portal_slug($1)', [attempt]),
      );
      if (rows.length > 0) {
        throw new Error(
          banner(
            `app.resolve_portal_slug matched ${rows.length} row(s) for the pattern "${attempt}".`,
            'The portal peephole must be exact-match only: a wildcard that resolves is a tenant directory.',
          ),
        );
      }
      expect(rows).toHaveLength(0);
    }
  });

  it('dpdp_app cannot read the org directory table directly (only through the function)', async () => {
    const has = await withRawConnection(pool, async (c) => {
      const { rows } = await c.query<{ has: boolean }>(
        `SELECT has_table_privilege(current_user, 'app.org_directory', 'SELECT') AS has`,
      );
      return rows[0]!.has;
    });
    expect(has).toBe(false);
  });

  // --- 2. Knowing a slug and a ticket id buys nothing -----------------------

  it("tenant B cannot read tenant A's ticket even knowing its exact id", async () => {
    const rows = await asTenant(pool, tenantB, async (client) => {
      const result = await client.query(
        'SELECT id, subject, contact_value FROM request_tickets WHERE id = $1',
        [ticketA],
      );
      return result.rows;
    });
    if (rows.length > 0) {
      throw new Error(
        banner(
          "Tenant B read tenant A's request ticket by id.",
          `Leaked: ${JSON.stringify(rows)}`,
          'A grievance contains a named complainant and their words. This is the worst possible leak.',
        ),
      );
    }
    expect(rows).toEqual([]);
  });

  it("tenant B cannot read tenant A's correspondence with a forgotten WHERE clause", async () => {
    const rows = await asTenant(pool, tenantB, async (client) => {
      const result = await client.query<{ body: string }>('SELECT body FROM request_correspondence');
      return result.rows;
    });
    expect(rows.map((r) => r.body)).toEqual([]);
  });

  it("tenant B cannot write into tenant A's ticket", async () => {
    await expect(
      asTenant(pool, tenantB, (client) =>
        client.query(`UPDATE request_tickets SET status = 'closed' WHERE id = $1`, [ticketA]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('every request table is fully RLS-protected (enabled, forced, policy)', async () => {
    const { rows } = await withRawConnection(pool, (c) =>
      c.query<{ table_name: string; ok: boolean }>(`
        SELECT c.relname AS table_name,
               (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
                  SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname)) AS ok
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'request\\_%'
        ORDER BY c.relname
      `),
    );
    // Not vacuous: the substrate has eight tables and they must all be found.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  // --- 3. The trails are append-only, for the role that actually runs ------

  it('correspondence cannot be edited or deleted — the trail is evidence (I4)', async () => {
    await expect(
      asTenant(pool, tenantA, (client) =>
        client.query('UPDATE request_correspondence SET body = $2 WHERE id = $1', [
          correspondenceA,
          'a quietly reworded complaint',
        ]),
      ),
    ).rejects.toThrow();

    await expect(
      asTenant(pool, tenantA, (client) =>
        client.query('DELETE FROM request_correspondence WHERE id = $1', [correspondenceA]),
      ),
    ).rejects.toThrow();

    // And it is still there, unchanged.
    const rows = await asTenant(pool, tenantA, async (client) => {
      const result = await client.query<{ body: string }>(
        'SELECT body FROM request_correspondence WHERE id = $1',
        [correspondenceA],
      );
      return result.rows;
    });
    expect(rows[0]!.body).toContain(A_MARKER);
  });

  it('status and escalation trails carry no UPDATE grant either', async () => {
    const grants = await withRawConnection(pool, async (c) => {
      const { rows } = await c.query<{ table_name: string; can_update: boolean; can_delete: boolean }>(
        `SELECT t AS table_name,
                has_table_privilege(current_user, t, 'UPDATE') AS can_update,
                has_table_privilege(current_user, t, 'DELETE') AS can_delete
           FROM unnest(ARRAY['public.request_status_events',
                             'public.request_correspondence',
                             'public.request_escalations']) AS t`,
      );
      return rows;
    });
    for (const grant of grants) {
      expect({ table: grant.table_name, update: grant.can_update }).toEqual({
        table: grant.table_name,
        update: false,
      });
      expect(grant.can_delete).toBe(false);
    }
  });

  // --- 4. Nothing is hard-deleted (I4) -------------------------------------

  it('no request table grants DELETE to the runtime role', async () => {
    const rows = await withRawConnection(pool, async (c) => {
      const result = await c.query<{ table_name: string; can_delete: boolean }>(`
        SELECT c.relname AS table_name,
               has_table_privilege(current_user, 'public.' || quote_ident(c.relname), 'DELETE') AS can_delete
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'request\\_%'
      `);
      return result.rows;
    });
    expect(rows.filter((r) => r.can_delete)).toEqual([]);
  });
});
