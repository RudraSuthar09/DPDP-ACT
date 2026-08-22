import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * Central DPDP Storage simplification follow-up: two small, additive columns
 * (1737004400000_consent-form-retention-and-local-sync.sql) —
 * consent_forms.retention_months and consent_form_submissions.local_synced_at.
 * Proves both persist across a fresh connection and stay tenant-isolated,
 * exactly like every other tenant-scoped column (I3, R5).
 */
describe('Consent form retention_months + local_synced_at — persistence and isolation', () => {
  let pool: Pool;
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

  async function createForm(tenantId: string, name: string, retentionMonths: number | null): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_forms (name, status, retention_months) VALUES ($1, 'published', $2) RETURNING id`,
        [name, retentionMonths],
      );
      return rows[0]!.id;
    });
  }

  async function createSubmission(tenantId: string, formId: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_form_submissions (form_id, subject_ref, channel) VALUES ($1, $2, 'link') RETURNING id`,
        [formId, `subj-${randomUUID()}`],
      );
      return rows[0]!.id;
    });
  }

  it('retention_months persists across a fresh query (a template retains the retention period it was saved with)', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-template-${randomUUID().slice(0, 8)}`, 6);
    const reloaded = await asTenant(pool, A.id, (c) =>
      c.query<{ retention_months: number | null }>('SELECT retention_months FROM consent_forms WHERE id = $1', [formId]),
    );
    expect(reloaded.rows[0]!.retention_months).toBe(6);
  });

  it('retention_months is optional — a template with none configured stores NULL, not a guessed default', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-template-${randomUUID().slice(0, 8)}`, null);
    const reloaded = await asTenant(pool, A.id, (c) =>
      c.query<{ retention_months: number | null }>('SELECT retention_months FROM consent_forms WHERE id = $1', [formId]),
    );
    expect(reloaded.rows[0]!.retention_months).toBeNull();
  });

  it('retention_months must be a positive whole number — the DB CHECK rejects zero/negative, DTO-independent', async () => {
    await expect(createForm(A.id, `${A_MARKER}-bad-${randomUUID().slice(0, 8)}`, 0)).rejects.toThrow(
      /violates check constraint/i,
    );
    await expect(createForm(A.id, `${A_MARKER}-bad-${randomUUID().slice(0, 8)}`, -3)).rejects.toThrow(
      /violates check constraint/i,
    );
  });

  it('tenant B cannot read tenant A\'s consent form (or its retention_months) — RLS, not app filtering', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-isolated-${randomUUID().slice(0, 8)}`, 12);
    const asB = await asTenant(pool, B.id, (c) => c.query('SELECT * FROM consent_forms WHERE id = $1', [formId]));
    expect(asB.rows).toHaveLength(0);
  });

  it('local_synced_at starts NULL (pending sync) and persists once set — a fresh query, not just the UPDATE\'s own RETURNING', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-sync-${randomUUID().slice(0, 8)}`, null);
    const submissionId = await createSubmission(A.id, formId);

    const before = await asTenant(pool, A.id, (c) =>
      c.query<{ local_synced_at: Date | null }>('SELECT local_synced_at FROM consent_form_submissions WHERE id = $1', [submissionId]),
    );
    expect(before.rows[0]!.local_synced_at).toBeNull();

    await asTenant(pool, A.id, (c) =>
      c.query(`UPDATE consent_form_submissions SET local_synced_at = now() WHERE id = $1 AND form_id = $2`, [submissionId, formId]),
    );

    const after = await asTenant(pool, A.id, (c) =>
      c.query<{ local_synced_at: Date | null }>('SELECT local_synced_at FROM consent_form_submissions WHERE id = $1', [submissionId]),
    );
    expect(after.rows[0]!.local_synced_at).not.toBeNull();
  });

  it('tenant B cannot mark tenant A\'s submission as synced — the scoped UPDATE (form_id + id) touches zero rows under RLS', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-guard-${randomUUID().slice(0, 8)}`, null);
    const submissionId = await createSubmission(A.id, formId);

    const attempt = await asTenant(pool, B.id, (c) =>
      c.query(`UPDATE consent_form_submissions SET local_synced_at = now() WHERE id = $1 AND form_id = $2`, [submissionId, formId]),
    );
    expect(attempt.rowCount).toBe(0);

    const stillNull = await asTenant(pool, A.id, (c) =>
      c.query<{ local_synced_at: Date | null }>('SELECT local_synced_at FROM consent_form_submissions WHERE id = $1', [submissionId]),
    );
    expect(stillNull.rows[0]!.local_synced_at).toBeNull();
  });
});
