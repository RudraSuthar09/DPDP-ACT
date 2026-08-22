import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * Central DPDP Storage customer-centric correction: consent_form_customer_
 * fields.is_identifier (1737004600000_consent-form-field-identifier.sql) —
 * at most one identifier field per form, DB-enforced (not just UI
 * discipline), so a stray API call can never leave a form with two.
 */
describe('consent_form_customer_fields.is_identifier — at most one per form (DB-enforced)', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createForm(tenantId: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_forms (name, status) VALUES ($1, 'published') RETURNING id`,
        [`${A_MARKER}-form-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
  }

  async function addField(tenantId: string, formId: string, label: string, isIdentifier: boolean): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_form_customer_fields (form_id, label, field_type, is_identifier) VALUES ($1, $2, 'text', $3) RETURNING id`,
        [formId, label, isIdentifier],
      );
      return rows[0]!.id;
    });
  }

  it('a form can have zero identifier fields — legitimate, not an error', async () => {
    const formId = await createForm(A.id);
    await expect(addField(A.id, formId, 'Aadhaar Number', false)).resolves.toBeTruthy();
    await expect(addField(A.id, formId, 'PAN Number', false)).resolves.toBeTruthy();
  });

  it('a form can have exactly one identifier field', async () => {
    const formId = await createForm(A.id);
    const fieldId = await addField(A.id, formId, 'Email', true);
    expect(fieldId).toBeTruthy();
  });

  it('a second identifier field on the SAME form is rejected by the database', async () => {
    const formId = await createForm(A.id);
    await addField(A.id, formId, 'Email', true);
    await expect(addField(A.id, formId, 'Mobile Number', true)).rejects.toThrow(
      /consent_form_customer_fields_one_identifier_per_form|violates unique constraint/i,
    );
  });

  it('two DIFFERENT forms can each have their own identifier field (the constraint is per-form, not global)', async () => {
    const formA = await createForm(A.id);
    const formB = await createForm(A.id);
    await expect(addField(A.id, formA, 'Email', true)).resolves.toBeTruthy();
    await expect(addField(A.id, formB, 'Student ID', true)).resolves.toBeTruthy();
  });

  it('marking a REMOVED field is_identifier does not block a new active identifier field (partial index scopes to status=active)', async () => {
    const formId = await createForm(A.id);
    const oldFieldId = await addField(A.id, formId, 'Old Email', true);
    await asTenant(pool, A.id, (c) =>
      c.query(`UPDATE consent_form_customer_fields SET status = 'removed' WHERE id = $1`, [oldFieldId]),
    );
    await expect(addField(A.id, formId, 'New Email', true)).resolves.toBeTruthy();
  });
});
