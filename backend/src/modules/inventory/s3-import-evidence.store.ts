import { Logger } from '@nestjs/common';
import { PutObjectCommand, type PutObjectCommandInput, type S3Client } from '@aws-sdk/client-s3';
import {
  ImportEvidenceStore,
  evidenceDigest,
  type ImportEvidenceRecord,
  type StoredImportEvidence,
} from './import-evidence.store';
import type { ImportEvidenceConfig } from './import-evidence.config';

/** The one S3 call this store makes. Narrowed so tests can supply a fake. */
export type EvidenceS3Client = Pick<S3Client, 'send'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Import evidence as encrypted, write-once S3 objects.
 *
 * WHAT GOES IN AN OBJECT: exactly what the local store writes — the
 * declaration (file name, table name, header column names, row count, who,
 * when) and the SHA-256 of the uploaded bytes. Never a data row, never the
 * file (I1).
 *
 * NAMING: `<prefix><tenantId>/<sha256>.json`. Both parts are validated before
 * use — a UUID and 64 hex characters — so no request-derived text (the file
 * name, a column header) can ever shape a key. The prefix is validated at
 * startup (import-evidence.config.ts).
 *
 * WRITE-ONCE: `If-None-Match: *` makes S3 refuse to overwrite. A 412 means the
 * same tenant declared byte-identical content before; since the key IS the
 * content hash, the existing object is identical by construction, so that is
 * success — exactly as the local store skips an existing file. Object Lock
 * retention, when configured, additionally stops anyone (including this
 * application's own role) deleting or replacing it until it expires.
 *
 * ENCRYPTION: always server-side — SSE-KMS with the configured key, else
 * SSE-S3 (AES-256). Explicit on every request, so a bucket whose default was
 * changed still never receives an unencrypted object from here.
 *
 * LOGGING: tenant prefix and digest only. Never the record, never the bucket
 * policy, never credentials (which this code never sees: the SDK resolves
 * them from the task role).
 */
export class S3ImportEvidenceStore extends ImportEvidenceStore {
  private readonly logger = new Logger(S3ImportEvidenceStore.name);

  constructor(
    private readonly client: EvidenceS3Client,
    private readonly config: ImportEvidenceConfig,
  ) {
    super();
    if (config.kind !== 's3' || !config.bucket) {
      throw new Error('S3ImportEvidenceStore requires an s3 configuration with a bucket.');
    }
  }

  async record(evidence: ImportEvidenceRecord, rawBytes: string): Promise<StoredImportEvidence> {
    const fileSha256 = evidenceDigest(rawBytes);
    const key = this.keyFor(evidence.tenantId, fileSha256);
    const evidencePath = `s3://${this.config.bucket}/${key}`;
    const stored: StoredImportEvidence = { ...evidence, fileSha256, evidencePath };

    const input: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: key,
      Body: JSON.stringify(stored, null, 2),
      ContentType: 'application/json',
      // Never overwrite: the evidence for a given hash is written once.
      IfNoneMatch: '*',
      // End-to-end integrity: S3 rejects the upload if the bytes it receives
      // do not match the checksum the SDK computed before sending.
      ChecksumAlgorithm: 'SHA256',
      ...(this.config.kmsKeyId
        ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.config.kmsKeyId }
        : { ServerSideEncryption: 'AES256' }),
      ...(this.config.retentionDays
        ? {
            ObjectLockMode: this.config.objectLockMode ?? 'COMPLIANCE',
            ObjectLockRetainUntilDate: new Date(
              Date.parse(evidence.importedAt) + this.config.retentionDays * DAY_MS,
            ),
          }
        : {}),
    };

    try {
      await this.client.send(new PutObjectCommand(input));
    } catch (err) {
      if (statusOf(err) === 412) {
        // Already recorded — identical by construction (content-addressed).
        return stored;
      }
      // Name and HTTP status only. An AWS error message can include the key,
      // and nothing about the request body; neither is customer data, but the
      // log line stays minimal on principle.
      this.logger.error(
        `Could not store import evidence (tenant ${evidence.tenantId.slice(0, 8)}…, digest ${fileSha256.slice(0, 12)}…): ` +
          `${(err as { name?: string }).name ?? 'Error'}${statusOf(err) ? ` (HTTP ${statusOf(err)})` : ''}`,
      );
      throw new Error(
        'Import evidence could not be stored. The import was not recorded; try again.',
      );
    }
    return stored;
  }

  /** `<prefix><tenantId>/<sha256>.json` — every part validated. */
  keyFor(tenantId: string, sha256: string): string {
    if (!UUID.test(tenantId))
      throw new Error('Refusing to store evidence: tenant id is not a UUID.');
    if (!SHA256_HEX.test(sha256))
      throw new Error('Refusing to store evidence: digest is not SHA-256 hex.');
    return `${this.config.prefix}${tenantId.toLowerCase()}/${sha256}.json`;
  }
}

function statusOf(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata;
  return meta?.httpStatusCode;
}
