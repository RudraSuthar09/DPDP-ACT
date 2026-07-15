import type { Pool, PoolClient } from 'pg';

/**
 * Run `fn` with the Postgres session bound to `tenantId`. This is the ONLY way a
 * tenant-scoped query reaches the database, and it is the answer to "how is the
 * GUC set on connection checkout, and how is it guaranteed set before any query?"
 *
 * The sequence, per unit of work:
 *   1. check out a pooled connection,
 *   2. `BEGIN` a transaction,
 *   3. set the `app.current_tenant` GUC as the FIRST statement, then
 *   4. run `fn` against that SAME client — so every query it issues already has
 *      RLS bound — and `COMMIT` (or `ROLLBACK` on error).
 *
 * Two properties make this safe:
 *   - It is set FIRST, on the same connection `fn` uses, so no query can run
 *     before the tenant is bound.
 *   - `set_config(..., is_local => true)` scopes the GUC to THIS transaction
 *     (like `SET LOCAL`), so it is cleared automatically on COMMIT/ROLLBACK. A
 *     connection returned to the pool can never leak one request's tenant into
 *     the next borrower.
 *
 * If `tenantId` is falsy we throw before touching the database — fail closed.
 */
export async function runWithTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error('runWithTenant called without a tenant id (Seam S1) — refusing to connect.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised equivalent of `SET LOCAL app.current_tenant = '<uuid>'`.
    // Using set_config avoids interpolating the id into SQL (injection-safe) and
    // the `true` marks it transaction-local.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);

    const result = await fn(client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure (e.g. connection already broken); surface the
      // original error to the caller.
    }
    throw err;
  } finally {
    client.release();
  }
}
