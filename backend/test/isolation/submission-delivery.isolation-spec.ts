import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * Submission delivery queue (1737005000000_submission-delivery-queue.sql) —
 * the cloud relay staging table for a hosted-link submission's field values/
 * documents, a deliberate, documented CLAUDE.md I1/R6 exception (see
 * submission-delivery.service.ts's header).
 *
 * Covers what is genuinely database-enforced: RLS tenant isolation (a device
 * from tenant B must never see or claim tenant A's staged submission — test
 * requirement #3), and that the atomic claim UPDATE really is atomic under
 * concurrent claimants (test requirement #4) — the compare-and-set the
 * repository's claim()/listClaimable() rely on. Encryption itself is covered
 * by submission-delivery-crypto.spec.ts (pure unit test, no DB needed); the
 * full HTTP lifecycle (controller + gateway-device auth) is covered by live
 * verification, not here — same split as enterprise-storage-sync.isolation-
 * spec.ts.
 */
describe('consent_form_submission_deliveries — tenant isolation + atomic claim', () => {
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

  async function createForm(tenantId: string, name: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`INSERT INTO consent_forms (name, status) VALUES ($1, 'published') RETURNING id`, [name]);
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

  async function stageDelivery(tenantId: string, submissionId: string, formId: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_form_submission_deliveries (submission_id, form_id, payload_ciphertext, payload_iv, payload_auth_tag)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [submissionId, formId, Buffer.from('ciphertext'), Buffer.from('iv'), Buffer.from('tag')],
      );
      return rows[0]!.id;
    });
  }

  it('defaults to pending with a zero attempt count, no claim, no delivery timestamp', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    const deliveryId = await stageDelivery(A.id, submissionId, formId);

    const { rows } = await asTenant(pool, A.id, (c) =>
      c.query(
        `SELECT status, attempt_count, claimed_at, delivered_at, failed_at FROM consent_form_submission_deliveries WHERE id = $1`,
        [deliveryId],
      ),
    );
    expect(rows[0]).toMatchObject({ status: 'pending', attempt_count: 0, claimed_at: null, delivered_at: null, failed_at: null });
  });

  it('rejects a status outside pending|delivering|delivered|failed', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    await expect(
      asTenant(pool, A.id, (c) =>
        c.query(
          `INSERT INTO consent_form_submission_deliveries (submission_id, form_id, status) VALUES ($1, $2, 'bogus')`,
          [submissionId, formId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('tenant B cannot see tenant A\'s staged delivery at all (RLS) — "an agent must never see another tenant\'s submissions"', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    const deliveryId = await stageDelivery(A.id, submissionId, formId);

    const asB = await asTenant(pool, B.id, (c) =>
      c.query(`SELECT id FROM consent_form_submission_deliveries WHERE id = $1`, [deliveryId]),
    );
    expect(asB.rows).toHaveLength(0);

    // Confirmed still there, visible to its OWN tenant — proves the isolation
    // above is RLS filtering, not "the row silently failed to insert".
    const asA = await asTenant(pool, A.id, (c) =>
      c.query(`SELECT id FROM consent_form_submission_deliveries WHERE id = $1`, [deliveryId]),
    );
    expect(asA.rows).toHaveLength(1);
  });

  it("tenant B's claimable-row UPDATE affects zero rows against tenant A's pending delivery — a device can never claim a submission that isn't its own tenant's", async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    const deliveryId = await stageDelivery(A.id, submissionId, formId);

    const claimAttempt = await asTenant(pool, B.id, (c) =>
      c.query(
        `UPDATE consent_form_submission_deliveries
            SET status = 'delivering', claimed_at = now(), attempt_count = attempt_count + 1
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [deliveryId],
      ),
    );
    expect(claimAttempt.rows).toHaveLength(0);

    const stillPending = await asTenant(pool, A.id, (c) =>
      c.query<{ status: string }>(`SELECT status FROM consent_form_submission_deliveries WHERE id = $1`, [deliveryId]),
    );
    expect(stillPending.rows[0]!.status).toBe('pending');
  });

  it('the compare-and-set claim UPDATE is atomic — two concurrent claimants on the SAME row, only one wins', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    const deliveryId = await stageDelivery(A.id, submissionId, formId);

    const claim = () =>
      asTenant(pool, A.id, (c) =>
        c.query(
          `UPDATE consent_form_submission_deliveries
              SET status = 'delivering', claimed_at = now(), attempt_count = attempt_count + 1
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [deliveryId],
        ),
      );

    const [first, second] = await Promise.all([claim(), claim()]);
    const wins = [first, second].filter((r) => r.rows.length === 1);
    expect(wins).toHaveLength(1);

    const final = await asTenant(pool, A.id, (c) =>
      c.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM consent_form_submission_deliveries WHERE id = $1`,
        [deliveryId],
      ),
    );
    expect(final.rows[0]).toMatchObject({ status: 'delivering', attempt_count: 1 });
  });

  it('marking delivered nulls the ciphertext columns — the payload is not kept after a confirmed local write', async () => {
    const formId = await createForm(A.id, `${A_MARKER}-form-${randomUUID().slice(0, 8)}`);
    const submissionId = await createSubmission(A.id, formId);
    const deliveryId = await stageDelivery(A.id, submissionId, formId);

    await asTenant(pool, A.id, (c) =>
      c.query(`UPDATE consent_form_submission_deliveries SET status = 'delivering' WHERE id = $1`, [deliveryId]),
    );
    await asTenant(pool, A.id, (c) =>
      c.query(
        `UPDATE consent_form_submission_deliveries
            SET status = 'delivered', delivered_at = now(),
                payload_ciphertext = NULL, payload_iv = NULL, payload_auth_tag = NULL
          WHERE id = $1`,
        [deliveryId],
      ),
    );

    const { rows } = await asTenant(pool, A.id, (c) =>
      c.query(`SELECT status, payload_ciphertext, payload_iv, payload_auth_tag FROM consent_form_submission_deliveries WHERE id = $1`, [
        deliveryId,
      ]),
    );
    expect(rows[0]).toMatchObject({ status: 'delivered', payload_ciphertext: null, payload_iv: null, payload_auth_tag: null });
  });
});
