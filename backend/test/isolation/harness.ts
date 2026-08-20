import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
// Import the REAL production helper so the suite exercises the exact code path
// the app uses — not a re-implementation that could drift from it.
import { runWithTenant } from '../../src/database/tenant-connection';

/**
 * Test harness for the cross-tenant isolation suite (R5, NFR-SEC-05).
 *
 * The suite connects as the least-privilege runtime role (APP_DATABASE_URL →
 * dpdp_app) and *attempts* to read another tenant's data. Every attempt must
 * come back empty because the Postgres engine (RLS) — not any application WHERE
 * clause — enforces isolation (invariant I3). If a single cross-tenant row ever
 * leaks, we fail LOUDLY: this suite protects the only promise the product sells.
 */

/** Recognisable markers so a leaked row is unmistakable in any result set. */
export const A_MARKER = 'TENANT-A-DATA';
export const B_MARKER = 'TENANT-B-SECRET';

export type Row = Record<string, unknown>;

export interface TenantFixture {
  id: string;
  orgName: string;
  categoryNames: string[];
  purposeNames: string[];
}

export function makeFixture(marker: string): TenantFixture {
  const id = randomUUID();
  return {
    id,
    orgName: `${marker} Org ${id.slice(0, 8)}`,
    categoryNames: [`${marker}-category-1`, `${marker}-category-2`],
    purposeNames: [`${marker}-purpose-1`],
  };
}

/**
 * All tenant-scoped tables the suite seeds and probes. `installations` added
 * for the locked-architecture foundation phase — trivially seedable (no FK
 * beyond tenant_id, which is auto-defaulted). `licenses` is deliberately NOT
 * here: it has a hard NOT NULL FK to `users.id` (created_by) that this
 * minimal-fixture harness has no user to satisfy; its RLS enabled/forced/
 * policy shape is still covered automatically by rls-preconditions.isolation-
 * spec.ts (which auto-discovers every tenant_id table), and its cross-tenant
 * behaviour is covered by scripts/deployment-topologies-e2e.mjs, which
 * creates real users through the real HTTP registration flow.
 */
export const TENANT_TABLES = ['organisations', 'inventory_categories', 'consent_purposes', 'installations'] as const;

export function getAppPool(): Pool {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      banner(
        'APP_DATABASE_URL is not set.',
        'The isolation suite must connect as the least-privilege dpdp_app role.',
        'Start infra, run migrations, then set APP_DATABASE_URL — see the README.',
      ),
    );
  }
  return new Pool({ connectionString, max: 5 });
}

/** Run `fn` as `tenantId` through the real production tenant-binding helper. */
export function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runWithTenant(pool, tenantId, fn);
}

/** Run `fn` on a bare connection with NO tenant GUC set (fail-closed probing). */
export async function withRawConnection<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Seed one tenant's rows across every tenant table, under its own context. */
export async function seedTenant(pool: Pool, t: TenantFixture): Promise<void> {
  await asTenant(pool, t.id, async (client) => {
    await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
      t.id,
      t.orgName,
    ]);
    for (const name of t.categoryNames) {
      await client.query('INSERT INTO inventory_categories (tenant_id, name) VALUES ($1, $2)', [
        t.id,
        name,
      ]);
    }
    for (const name of t.purposeNames) {
      await client.query('INSERT INTO consent_purposes (tenant_id, name) VALUES ($1, $2)', [
        t.id,
        name,
      ]);
    }
    await client.query(
      `INSERT INTO installations (tenant_id, plan, deployment_type, version)
       VALUES ($1, 'enterprise', 'client_server', '1.0.0-test')`,
      [t.id],
    );
  });
}

/** A big, unmissable failure banner for CI logs. */
export function banner(...lines: string[]): string {
  const bar = '='.repeat(74);
  return [
    '',
    bar,
    '  ❌ CROSS-TENANT ISOLATION FAILURE',
    ...lines.map((l) => `  ${l}`),
    bar,
    '',
  ].join('\n');
}

/** Rows that belong to the "other" tenant — identified by id OR by marker. */
export function leakedRows(rows: Row[], otherTenantId: string): Row[] {
  return rows.filter(
    (r) =>
      r.tenant_id === otherTenantId ||
      (typeof r.name === 'string' && r.name.includes(B_MARKER)) ||
      (typeof r.org_name === 'string' && r.org_name.includes(B_MARKER)),
  );
}

/**
 * The core assertion: NOT ONE row may belong to the other tenant. On any leak we
 * throw a loud, detailed error so CI fails unmistakably.
 */
export function assertNoLeak(rows: Row[], otherTenantId: string, context: string): void {
  const leaks = leakedRows(rows, otherTenantId);
  if (leaks.length > 0) {
    throw new Error(
      banner(
        `Context: ${context}`,
        `Leaked ${leaks.length} row(s) belonging to another tenant.`,
        `Offending rows: ${JSON.stringify(leaks)}`,
        'RLS did not contain the query. Isolation is broken — do NOT ship.',
      ),
    );
  }
}
