/**
 * Runtime configuration for where CSV/Excel import evidence is kept.
 *
 *   IMPORT_EVIDENCE_STORE              local (default) | s3
 *   IMPORT_EVIDENCE_S3_BUCKET          required for s3
 *   IMPORT_EVIDENCE_S3_PREFIX          key prefix, default "inventory-import-evidence/"
 *   IMPORT_EVIDENCE_S3_KMS_KEY_ID      optional: SSE-KMS with this key; otherwise SSE-S3 (AES-256)
 *   IMPORT_EVIDENCE_RETENTION_DAYS     optional: Object Lock retention per object
 *   IMPORT_EVIDENCE_OBJECT_LOCK_MODE   COMPLIANCE (default when retention is set) | GOVERNANCE
 *
 * The S3 client takes its region and credentials from the AWS SDK's default
 * chain — on ECS, AWS_REGION and the TASK ROLE. Access keys never belong in
 * this configuration.
 *
 * One parser, used both by startup validation (so a bad value stops the
 * process with a clear message) and by the store factory (so the two can
 * never disagree about what is valid).
 */
export interface ImportEvidenceConfig {
  kind: 'local' | 's3';
  bucket?: string;
  prefix: string;
  kmsKeyId?: string;
  retentionDays?: number;
  objectLockMode?: 'COMPLIANCE' | 'GOVERNANCE';
}

export const DEFAULT_EVIDENCE_PREFIX = 'inventory-import-evidence/';

/** S3's own bucket-naming rules (3-63 chars, lowercase, digits, dots, hyphens). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** A prefix is a path of plain segments ending in "/": no traversal, no leading
 *  slash, no doubled slashes, nothing a key could be steered with. */
const SAFE_PREFIX = /^([A-Za-z0-9_-]+\/)*$/;
/** Ten years. Longer than any retention a DPDP evidence record plausibly
 *  needs; a guard against a typo locking objects for centuries. */
const MAX_RETENTION_DAYS = 3650;

export type ImportEvidenceConfigResult =
  { ok: true; config: ImportEvidenceConfig } | { ok: false; errors: string[] };

export function parseImportEvidenceConfig(
  env: Record<string, unknown>,
): ImportEvidenceConfigResult {
  const get = (k: string): string | undefined => {
    const v = env[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const errors: string[] = [];
  const kind = (get('IMPORT_EVIDENCE_STORE') ?? 'local').toLowerCase();
  if (kind !== 'local' && kind !== 's3') {
    return { ok: false, errors: ['IMPORT_EVIDENCE_STORE must be "local" or "s3".'] };
  }
  const prefix = get('IMPORT_EVIDENCE_S3_PREFIX') ?? DEFAULT_EVIDENCE_PREFIX;
  if (kind === 'local') return { ok: true, config: { kind: 'local', prefix } };

  const bucket = get('IMPORT_EVIDENCE_S3_BUCKET');
  if (!bucket) errors.push('IMPORT_EVIDENCE_S3_BUCKET is required when IMPORT_EVIDENCE_STORE=s3.');
  else if (!BUCKET_NAME.test(bucket) || bucket.includes('..')) {
    errors.push('IMPORT_EVIDENCE_S3_BUCKET is not a valid S3 bucket name.');
  }
  if (!SAFE_PREFIX.test(prefix)) {
    errors.push(
      'IMPORT_EVIDENCE_S3_PREFIX must be plain path segments ending in "/" (e.g. "inventory-import-evidence/"), with no leading "/" or "..".',
    );
  }

  let retentionDays: number | undefined;
  const rawDays = get('IMPORT_EVIDENCE_RETENTION_DAYS');
  if (rawDays !== undefined) {
    if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > MAX_RETENTION_DAYS) {
      errors.push(
        `IMPORT_EVIDENCE_RETENTION_DAYS must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}.`,
      );
    } else retentionDays = Number(rawDays);
  }

  let objectLockMode: 'COMPLIANCE' | 'GOVERNANCE' | undefined;
  const rawMode = get('IMPORT_EVIDENCE_OBJECT_LOCK_MODE');
  if (rawMode !== undefined) {
    const m = rawMode.toUpperCase();
    if (m !== 'COMPLIANCE' && m !== 'GOVERNANCE') {
      errors.push('IMPORT_EVIDENCE_OBJECT_LOCK_MODE must be COMPLIANCE or GOVERNANCE.');
    } else if (retentionDays === undefined) {
      errors.push(
        'IMPORT_EVIDENCE_OBJECT_LOCK_MODE only applies together with IMPORT_EVIDENCE_RETENTION_DAYS.',
      );
    } else objectLockMode = m;
  } else if (retentionDays !== undefined) {
    objectLockMode = 'COMPLIANCE';
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      kind: 's3',
      bucket,
      prefix,
      kmsKeyId: get('IMPORT_EVIDENCE_S3_KMS_KEY_ID'),
      retentionDays,
      objectLockMode,
    },
  };
}
