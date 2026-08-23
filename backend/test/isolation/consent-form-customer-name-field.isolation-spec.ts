import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';

/**
 * consent_form_customer_fields.is_customer_name
 * (1737004900000_customer-display-name.sql) — is_identifier's sibling, same
 * discipline (at most one per form, DB-enforced), but a SEPARATE flag: the
 * field that names a customer's filesystem folder need not be the same
 * field that resolves their identity.
 */
describe('consent_form_customer_fields.is_customer_name — at most one per form (DB-enforced), independent of is_identifier', () => {
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

  async function addField(
    tenantId: string,
    formId: string,
    label: string,
    opts: { isIdentifier?: boolean; isCustomerName?: boolean } = {},
  ): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO consent_form_customer_fields (form_id, label, field_type, is_identifier, is_customer_name)
         VALUES ($1, $2, 'text', $3, $4) RETURNING id`,
        [formId, label, opts.isIdentifier ?? false, opts.isCustomerName ?? false],
      );
      return rows[0]!.id;
    });
  }

  it('a form can have zero customer-name fields — legitimate, not an error', async () => {
    const formId = await createForm(A.id);
    await expect(addField(A.id, formId, 'Aadhaar Number')).resolves.toBeTruthy();
  });

  it('a form can have exactly one customer-name field', async () => {
    const formId = await createForm(A.id);
    await expect(addField(A.id, formId, 'Customer Name', { isCustomerName: true })).resolves.toBeTruthy();
  });

  it('a second customer-name field on the SAME form is rejected by the database', async () => {
    const formId = await createForm(A.id);
    await addField(A.id, formId, 'Customer Name', { isCustomerName: true });
    await expect(addField(A.id, formId, 'Full Name', { isCustomerName: true })).rejects.toThrow(
      /consent_form_customer_fields_one_customer_name_per_form|violates unique constraint/i,
    );
  });

  it('the customer-name constraint does NOT block a second identifier field being added on an unrelated field (constraints are independent)', async () => {
    const formId = await createForm(A.id);
    await addField(A.id, formId, 'Customer Name', { isCustomerName: true });
    await expect(addField(A.id, formId, 'Email', { isIdentifier: true })).resolves.toBeTruthy();
  });

  it('ONE field may be BOTH the identifier and the customer name at once — the client may choose the same field for both roles', async () => {
    const formId = await createForm(A.id);
    await expect(addField(A.id, formId, 'Email', { isIdentifier: true, isCustomerName: true })).resolves.toBeTruthy();
  });

  it('two DIFFERENT fields may hold the two DIFFERENT roles on the same form', async () => {
    const formId = await createForm(A.id);
    await addField(A.id, formId, 'Customer Name', { isCustomerName: true });
    await addField(A.id, formId, 'Email', { isIdentifier: true });
    const { rows } = await asTenant(pool, A.id, (c) =>
      c.query<{ label: string; is_identifier: boolean; is_customer_name: boolean }>(
        `SELECT label, is_identifier, is_customer_name FROM consent_form_customer_fields WHERE form_id = $1 ORDER BY label`,
        [formId],
      ),
    );
    expect(rows).toEqual([
      { label: 'Customer Name', is_identifier: false, is_customer_name: true },
      { label: 'Email', is_identifier: true, is_customer_name: false },
    ]);
  });
});

describe('data_principals.display_name — set once, refreshed by a later name, never blanked by a submission with none', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function resolve(tenantId: string, subjectRef: string, displayName: string | null): Promise<{ id: string; display_name: string | null }> {
    return asTenant(pool, tenantId, async (c) => {
      const { rows } = await c.query<{ id: string; display_name: string | null }>(
        `INSERT INTO data_principals (subject_ref, display_name) VALUES ($1, $2)
         ON CONFLICT ON CONSTRAINT data_principals_tenant_subject_uq
         DO UPDATE SET updated_at = now(), display_name = COALESCE($2, data_principals.display_name)
         RETURNING id, display_name`,
        [subjectRef, displayName],
      );
      return rows[0]!;
    });
  }

  it('records the display name on first resolution', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const row = await resolve(A.id, subjectRef, 'Rudra Suthar');
    expect(row.display_name).toBe('Rudra Suthar');
  });

  it('a later resolution with NO name does not blank out the existing one', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const first = await resolve(A.id, subjectRef, 'Rudra Suthar');
    const second = await resolve(A.id, subjectRef, null);
    expect(second.id).toBe(first.id);
    expect(second.display_name).toBe('Rudra Suthar');
  });

  it('a later resolution WITH a new name refreshes it, without creating a new customer', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const first = await resolve(A.id, subjectRef, 'Rudra S.');
    const second = await resolve(A.id, subjectRef, 'Rudra Suthar');
    expect(second.id).toBe(first.id);
    expect(second.display_name).toBe('Rudra Suthar');
  });

  it('a customer with no name field configured resolves with display_name null — legitimate, not an error', async () => {
    const subjectRef = `subj-${randomUUID()}`;
    const row = await resolve(A.id, subjectRef, null);
    expect(row.display_name).toBeNull();
  });
});
