import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LocalImportEvidenceStore,
  evidenceDigest,
  type ImportEvidenceRecord,
} from './import-evidence.store';
import { S3ImportEvidenceStore } from './s3-import-evidence.store';
import {
  DEFAULT_EVIDENCE_PREFIX,
  parseImportEvidenceConfig,
  type ImportEvidenceConfig,
} from './import-evidence.config';

/**
 * Import evidence: what is written, where, and that it is never overwritten.
 * The S3 client is a fake that records the exact request, so these tests show
 * what would be sent to AWS without any AWS account.
 */

const TENANT = '3f1c2a4e-9b7d-4c1e-8a2b-1234567890ab';
const RECORD: ImportEvidenceRecord = {
  tenantId: TENANT,
  fileName: 'customers-2026.csv',
  tableName: 'customers',
  headerColumns: ['name', 'email', 'phone'],
  rowCountDeclared: 3,
  importedAt: '2026-11-04T10:00:00.000Z',
  importedBy: 'user-1',
};
const CSV =
  'name,email,phone\nAsha,asha@example.com,9876543210\nRavi,ravi@example.com,9123456780\n';

const s3 = (over: Partial<ImportEvidenceConfig> = {}): ImportEvidenceConfig => ({
  kind: 's3',
  bucket: 'dpdp-evidence-prod',
  prefix: DEFAULT_EVIDENCE_PREFIX,
  ...over,
});

function fakeS3(behaviour: 'ok' | 412 | 403 = 'ok') {
  const sent: PutObjectCommand[] = [];
  return {
    sent,
    client: {
      send: jest.fn(async (cmd: PutObjectCommand) => {
        sent.push(cmd);
        if (behaviour !== 'ok') {
          const err = Object.assign(new Error('AWS said no'), {
            name: behaviour === 412 ? 'PreconditionFailed' : 'AccessDenied',
            $metadata: { httpStatusCode: behaviour },
          });
          throw err;
        }
        return {};
      }),
    } as never,
  };
}

describe('S3 import evidence', () => {
  it('writes ONE object, keyed only by tenant UUID and content hash', async () => {
    const { client, sent } = fakeS3();
    const stored = await new S3ImportEvidenceStore(client, s3()).record(RECORD, CSV);
    const input = sent[0]!.input;
    expect(input.Bucket).toBe('dpdp-evidence-prod');
    expect(input.Key).toBe(`inventory-import-evidence/${TENANT}/${evidenceDigest(CSV)}.json`);
    expect(stored.evidencePath).toBe(`s3://dpdp-evidence-prod/${input.Key}`);
    // The customer's file name never shapes the key.
    expect(input.Key).not.toContain('customers-2026');
  });

  it('never overwrites: the request is conditional on the object not existing', async () => {
    const { client, sent } = fakeS3();
    await new S3ImportEvidenceStore(client, s3()).record(RECORD, CSV);
    expect(sent[0]!.input.IfNoneMatch).toBe('*');
    expect(sent[0]!.input.ChecksumAlgorithm).toBe('SHA256');
  });

  it('an identical re-import (412) is success — the existing object is identical by construction', async () => {
    const { client } = fakeS3(412);
    await expect(
      new S3ImportEvidenceStore(client, s3()).record(RECORD, CSV),
    ).resolves.toMatchObject({
      fileSha256: evidenceDigest(CSV),
    });
  });

  it('encrypts server-side with SSE-S3 by default, SSE-KMS when a key is configured', async () => {
    const a = fakeS3();
    await new S3ImportEvidenceStore(a.client, s3()).record(RECORD, CSV);
    expect(a.sent[0]!.input).toMatchObject({ ServerSideEncryption: 'AES256' });
    expect(a.sent[0]!.input.SSEKMSKeyId).toBeUndefined();

    const b = fakeS3();
    await new S3ImportEvidenceStore(b.client, s3({ kmsKeyId: 'alias/dpdp-evidence' })).record(
      RECORD,
      CSV,
    );
    expect(b.sent[0]!.input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'alias/dpdp-evidence',
    });
  });

  it('applies Object Lock retention counted from the import time, when configured', async () => {
    const { client, sent } = fakeS3();
    await new S3ImportEvidenceStore(
      client,
      s3({ retentionDays: 2555, objectLockMode: 'COMPLIANCE' }),
    ).record(RECORD, CSV);
    expect(sent[0]!.input.ObjectLockMode).toBe('COMPLIANCE');
    // 2026-11-04T10:00Z + 2555 days, computed independently with calendar arithmetic.
    expect(sent[0]!.input.ObjectLockRetainUntilDate).toEqual(new Date('2033-11-02T10:00:00.000Z'));
  });

  it('sends no retention fields when retention is not configured', async () => {
    const { client, sent } = fakeS3();
    await new S3ImportEvidenceStore(client, s3()).record(RECORD, CSV);
    expect(sent[0]!.input.ObjectLockMode).toBeUndefined();
    expect(sent[0]!.input.ObjectLockRetainUntilDate).toBeUndefined();
  });

  it('stores the declaration and the hash — NEVER a data row', async () => {
    const { client, sent } = fakeS3();
    await new S3ImportEvidenceStore(client, s3()).record(RECORD, CSV);
    const body = String(sent[0]!.input.Body);
    expect(JSON.parse(body)).toMatchObject({
      headerColumns: ['name', 'email', 'phone'],
      rowCountDeclared: 3,
    });
    for (const value of ['asha@example.com', '9876543210', 'Ravi'])
      expect(body).not.toContain(value);
  });

  it('a storage failure fails the import with a message that leaks nothing', async () => {
    const { client } = fakeS3(403);
    const err = await new S3ImportEvidenceStore(client, s3())
      .record(RECORD, CSV)
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'Import evidence could not be stored. The import was not recorded; try again.',
    );
    expect((err as Error).message).not.toMatch(/dpdp-evidence-prod|asha|AWS said no/);
  });

  it('refuses a tenant id that is not a UUID rather than building a key from it', async () => {
    const { client } = fakeS3();
    await expect(
      new S3ImportEvidenceStore(client, s3()).record(
        { ...RECORD, tenantId: '../other-tenant' },
        CSV,
      ),
    ).rejects.toThrow(/not a UUID/);
    expect((client as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });
});

describe('local import evidence — unchanged behaviour', () => {
  it('writes the same declaration to disk once, read-only, and skips an identical second write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dpdp-evidence-'));
    const store = new LocalImportEvidenceStore(dir);
    const first = await store.record(RECORD, CSV);
    expect(first.evidencePath).toBe(join(dir, TENANT, `${evidenceDigest(CSV)}.json`));
    expect(JSON.parse(readFileSync(first.evidencePath, 'utf8'))).toMatchObject({
      rowCountDeclared: 3,
    });
    // read-only (Windows reports 0o444 files as 0o444 too)
    expect(statSync(first.evidencePath).mode & 0o222).toBe(0);
    await expect(store.record(RECORD, CSV)).resolves.toMatchObject({
      fileSha256: first.fileSha256,
    });
  });
});

describe('evidence configuration', () => {
  it('defaults to local — local development is unchanged', () => {
    expect(parseImportEvidenceConfig({})).toEqual({
      ok: true,
      config: { kind: 'local', prefix: DEFAULT_EVIDENCE_PREFIX },
    });
  });

  it('s3 requires a valid bucket', () => {
    expect(parseImportEvidenceConfig({ IMPORT_EVIDENCE_STORE: 's3' })).toEqual({
      ok: false,
      errors: ['IMPORT_EVIDENCE_S3_BUCKET is required when IMPORT_EVIDENCE_STORE=s3.'],
    });
    expect(
      parseImportEvidenceConfig({
        IMPORT_EVIDENCE_STORE: 's3',
        IMPORT_EVIDENCE_S3_BUCKET: 'Bad_Bucket',
      }),
    ).toMatchObject({ ok: false });
  });

  it.each(['/abs/', 'a/../b/', 'no-trailing-slash', 'a//b/', 'a b/'])(
    'refuses an unsafe prefix "%s"',
    (prefix) => {
      expect(
        parseImportEvidenceConfig({
          IMPORT_EVIDENCE_STORE: 's3',
          IMPORT_EVIDENCE_S3_BUCKET: 'dpdp-evidence',
          IMPORT_EVIDENCE_S3_PREFIX: prefix,
        }),
      ).toMatchObject({ ok: false });
    },
  );

  it('retention defaults to COMPLIANCE mode, and a mode without retention is an error', () => {
    expect(
      parseImportEvidenceConfig({
        IMPORT_EVIDENCE_STORE: 's3',
        IMPORT_EVIDENCE_S3_BUCKET: 'dpdp-evidence',
        IMPORT_EVIDENCE_RETENTION_DAYS: '365',
      }),
    ).toMatchObject({ ok: true, config: { retentionDays: 365, objectLockMode: 'COMPLIANCE' } });
    expect(
      parseImportEvidenceConfig({
        IMPORT_EVIDENCE_STORE: 's3',
        IMPORT_EVIDENCE_S3_BUCKET: 'dpdp-evidence',
        IMPORT_EVIDENCE_OBJECT_LOCK_MODE: 'GOVERNANCE',
      }),
    ).toMatchObject({ ok: false });
  });

  it.each(['0', '-1', '3651', 'ten', '1.5'])('refuses retention "%s"', (days) => {
    expect(
      parseImportEvidenceConfig({
        IMPORT_EVIDENCE_STORE: 's3',
        IMPORT_EVIDENCE_S3_BUCKET: 'dpdp-evidence',
        IMPORT_EVIDENCE_RETENTION_DAYS: days,
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses an unknown store kind', () => {
    expect(parseImportEvidenceConfig({ IMPORT_EVIDENCE_STORE: 'gcs' })).toEqual({
      ok: false,
      errors: ['IMPORT_EVIDENCE_STORE must be "local" or "s3".'],
    });
  });
});
