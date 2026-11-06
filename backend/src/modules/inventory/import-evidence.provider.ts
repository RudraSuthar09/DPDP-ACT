import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { ImportEvidenceStore, LocalImportEvidenceStore } from './import-evidence.store';
import { parseImportEvidenceConfig } from './import-evidence.config';
import { S3ImportEvidenceStore } from './s3-import-evidence.store';

/**
 * Chooses the import-evidence store once, at startup. The configuration has
 * already been validated by config/env.validation.ts, so a parse failure here
 * is a programming error, not a user mistake — it still fails loudly.
 */
export const importEvidenceStoreProvider: Provider = {
  provide: ImportEvidenceStore,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ImportEvidenceStore => {
    const parsed = parseImportEvidenceConfig({
      IMPORT_EVIDENCE_STORE: config.get('IMPORT_EVIDENCE_STORE'),
      IMPORT_EVIDENCE_S3_BUCKET: config.get('IMPORT_EVIDENCE_S3_BUCKET'),
      IMPORT_EVIDENCE_S3_PREFIX: config.get('IMPORT_EVIDENCE_S3_PREFIX'),
      IMPORT_EVIDENCE_S3_KMS_KEY_ID: config.get('IMPORT_EVIDENCE_S3_KMS_KEY_ID'),
      IMPORT_EVIDENCE_RETENTION_DAYS: config.get('IMPORT_EVIDENCE_RETENTION_DAYS'),
      IMPORT_EVIDENCE_OBJECT_LOCK_MODE: config.get('IMPORT_EVIDENCE_OBJECT_LOCK_MODE'),
    });
    if (!parsed.ok)
      throw new Error(`Import evidence store misconfigured: ${parsed.errors.join(' ')}`);
    const logger = new Logger('ImportEvidenceStore');
    if (parsed.config.kind === 'local') {
      logger.log('Import evidence: local disk (backend/var). Not durable on a container platform.');
      return new LocalImportEvidenceStore();
    }
    const c = parsed.config;
    logger.log(
      `Import evidence: S3, ${c.kmsKeyId ? 'SSE-KMS' : 'SSE-S3'}` +
        (c.retentionDays
          ? `, Object Lock ${c.objectLockMode} ${c.retentionDays} days`
          : ', no Object Lock retention'),
    );
    // Region and credentials from the SDK's default chain (AWS_REGION + the
    // ECS task role). Never configured here.
    return new S3ImportEvidenceStore(new S3Client({}), c);
  },
};
