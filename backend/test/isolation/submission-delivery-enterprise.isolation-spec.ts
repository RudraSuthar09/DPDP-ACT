import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { A_MARKER, B_MARKER, asTenant, getAppPool, makeFixture, seedTenant, type TenantFixture } from './harness';
import { SubmissionDeliveryRepository } from '../../src/modules/delivery/submission-delivery.repository';
import type { TenantDatabaseService } from '../../src/database/database.service';

/**
 * Enterprise per-field consent copies (1737005400000_submission-delivery-
 * enterprise-target.sql) against a REAL PostgreSQL, through the REAL
 * repository SQL (not a copy of it): routing by target_storage_root_id, the
 * per-destination status query, RLS, and the migration's tenant-binding
 * trigger (a plain FK skips RLS, so the trigger is the actual guard).
 */
describe('consent_form_submission_deliveries.target_storage_root_id — routing, status, isolation', () => {
  let pool: Pool;
  const A: TenantFixture = makeFixture(A_MARKER);
  const B: TenantFixture = makeFixture(B_MARKER);
  let rootA: string;
  let rootB: string;

  /** The real repository, bound to one tenant the way TenantDatabaseService
   *  binds it per request. */
  const repoFor = (tenantId: string) =>
    new SubmissionDeliveryRepository({ withTenant: <T>(fn: (c: PoolClient) => Promise<T>) => asTenant(pool, tenantId, fn) } as unknown as TenantDatabaseService);

  async function gatewayRoot(tenantId: string): Promise<string> {
    return asTenant(pool, tenantId, async (c) => {
      const device = await c.query<{ id: string }>(
        `INSERT INTO gateway_devices (public_key, platform, agent_version, display_name) VALUES ('PK', 'windows', '0.1.0', 'GW') RETURNING id`,
      );
      const root = await c.query<{ id: string }>(
        `INSERT INTO storage_roots (name, provider, gateway_device_id) VALUES ($1, 'gateway', $2) RETURNING id`,
        [`loc-${randomUUID().slice(0, 8)}`, device.rows[0]!.id],
      );
      return root.rows[0]!.id;
    });
  }

  async function submission(tenantId: string): Promise<{ formId: string; submissionId: string }> {
    return asTenant(pool, tenantId, async (c) => {
      const form = await c.query<{ id: string }>(`INSERT INTO consent_forms (name, status) VALUES ('KYC', 'published') RETURNING id`);
      const sub = await c.query<{ id: string }>(
        `INSERT INTO consent_form_submissions (form_id, subject_ref, channel) VALUES ($1, $2, 'link') RETURNING id`,
        [form.rows[0]!.id, `subj-${randomUUID()}`],
      );
      return { formId: form.rows[0]!.id, submissionId: sub.rows[0]!.id };
    });
  }

  const payload = { ciphertext: Buffer.from('ct'), iv: Buffer.from('iv'), authTag: Buffer.from('tag') };

  beforeAll(async () => {
    pool = getAppPool();
    await seedTenant(pool, A);
    await seedTenant(pool, B);
    rootA = await gatewayRoot(A.id);
    rootB = await gatewayRoot(B.id);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('existing-style rows (no target) are Central; Enterprise rows carry their root', async () => {
    const { formId, submissionId } = await submission(A.id);
    const central = await repoFor(A.id).create({ submissionId, formId, ...payload });
    const copy = await repoFor(A.id).create({ submissionId, formId, ...payload, targetStorageRootId: rootA });
    expect(central.target_storage_root_id).toBeNull();
    expect(copy.target_storage_root_id).toBe(rootA);
  });

  it('a row can never target ANOTHER tenant\'s storage root (trigger, not just the service)', async () => {
    const { formId, submissionId } = await submission(A.id);
    await expect(repoFor(A.id).create({ submissionId, formId, ...payload, targetStorageRootId: rootB })).rejects.toThrow(/does not belong to this tenant/);
  });

  it('claim selection only offers what the device can perform', async () => {
    const tenant = makeFixture(A_MARKER);
    await seedTenant(pool, tenant);
    const root = await gatewayRoot(tenant.id);
    const repo = repoFor(tenant.id);
    const { formId, submissionId } = await submission(tenant.id);
    const central = await repo.create({ submissionId, formId, ...payload });
    const copy = await repo.create({ submissionId, formId, ...payload, targetStorageRootId: root });

    const ids = async (f: { central: boolean; storageRootIds: string[] }) => (await repo.listClaimableFor(10, f)).map((r) => r.id).sort();
    expect(await ids({ central: true, storageRootIds: [] })).toEqual([central.id]); // an older agent: Central only
    expect(await ids({ central: false, storageRootIds: [root] })).toEqual([copy.id]); // a Windows Gateway with a write grant
    expect(await ids({ central: false, storageRootIds: [] })).toEqual([]);
    expect(await ids({ central: true, storageRootIds: [root] })).toEqual([central.id, copy.id].sort());
    expect(await ids({ central: false, storageRootIds: [rootB] })).toEqual([]); // another tenant's root id: nothing
  });

  it('claim -> ack nulls the payload; per-destination status reports each destination separately', async () => {
    const tenant = makeFixture(A_MARKER);
    await seedTenant(pool, tenant);
    const root = await gatewayRoot(tenant.id);
    const repo = repoFor(tenant.id);
    const { formId, submissionId } = await submission(tenant.id);
    await repo.create({ submissionId, formId, ...payload });
    const copy = await repo.create({ submissionId, formId, ...payload, targetStorageRootId: root });
    const device = (await asTenant(pool, tenant.id, (c) => c.query<{ id: string }>('SELECT gateway_device_id AS id FROM storage_roots WHERE id = $1', [root]))).rows[0]!.id;

    expect(await repo.claim(copy.id, device)).toMatchObject({ status: 'delivering', attempt_count: 1 });
    expect(await repo.markDelivered(copy.id)).toMatchObject({ status: 'delivered', payload_ciphertext: null, payload_iv: null, payload_auth_tag: null });

    const statuses = await repo.latestStatusForSubmissions([submissionId]);
    expect(statuses.map((s) => [s.target_storage_root_id, s.status]).sort()).toEqual(
      [
        [null, 'pending'],
        [root, 'delivered'],
      ].sort(),
    );
  });

  it('tenant B can neither see nor be offered tenant A\'s Enterprise copies (RLS)', async () => {
    const { formId, submissionId } = await submission(A.id);
    await repoFor(A.id).create({ submissionId, formId, ...payload, targetStorageRootId: rootA });
    expect(await repoFor(B.id).listClaimableFor(50, { central: true, storageRootIds: [rootA] })).toEqual([]);
    expect(await repoFor(B.id).latestStatusForSubmissions([submissionId])).toEqual([]);
  });
});
