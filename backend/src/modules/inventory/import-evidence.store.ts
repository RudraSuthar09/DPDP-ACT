import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

export interface ImportEvidenceRecord {
  tenantId: string;
  fileName: string;
  tableName: string;
  headerColumns: string[];
  rowCountDeclared: number;
  importedAt: string;
  importedBy: string | null;
}

export interface StoredImportEvidence extends ImportEvidenceRecord {
  fileSha256: string;
  /** Where the evidence lives: a local file path, or `s3://bucket/key`. */
  evidencePath: string;
}

/**
 * WORM-style evidence of a CSV/Excel import declaration (FR-INV-02).
 *
 * Deliberately stores ONLY the declaration — header column names, a SHA-256 of
 * the full uploaded bytes, and a row COUNT — never the file's data rows, and
 * never the raw file itself (I1). A raw-file copy would itself violate I1 the
 * moment the file contains real customer rows, which is exactly the scenario
 * this feature has to withstand. The hash is computed over the bytes in
 * memory; those bytes are never written anywhere and are discarded the moment
 * this call returns — only the fixed-size digest is retained.
 *
 * Two implementations, chosen at startup by IMPORT_EVIDENCE_STORE (see
 * import-evidence.config.ts):
 *   - `local` (default): a file on the container's disk, chmod'd read-only.
 *     Right for development and for an on-premises installation with a
 *     persistent disk; WRONG for a container platform that replaces disks on
 *     every deploy, where the evidence would silently disappear.
 *   - `s3`: one encrypted, write-once object per declaration
 *     (s3-import-evidence.store.ts), optionally under Object Lock retention.
 *
 * This abstract class is the injection token, so the one caller
 * (RegisterImportService) is unaware of which is in use.
 */
export abstract class ImportEvidenceStore {
  abstract record(evidence: ImportEvidenceRecord, rawBytes: string): Promise<StoredImportEvidence>;
}

/** The digest every implementation stores under — content-addressing means an
 *  identical file declared twice resolves to the same evidence. */
export function evidenceDigest(rawBytes: string): string {
  return createHash('sha256').update(rawBytes, 'utf8').digest('hex');
}

/**
 * The original local-disk store, unchanged in behaviour: a local equivalent of
 * S3 Object Lock — written once, then chmod'd read-only, and never opened for
 * writing again.
 */
@Injectable()
export class LocalImportEvidenceStore extends ImportEvidenceStore {
  constructor(
    private readonly baseDir: string = join(process.cwd(), 'var', 'inventory-import-evidence'),
  ) {
    super();
  }

  async record(evidence: ImportEvidenceRecord, rawBytes: string): Promise<StoredImportEvidence> {
    const fileSha256 = evidenceDigest(rawBytes);
    const tenantDir = join(this.baseDir, evidence.tenantId);
    await mkdir(tenantDir, { recursive: true });

    const evidencePath = join(tenantDir, `${fileSha256}.json`);
    const stored: StoredImportEvidence = { ...evidence, fileSha256, evidencePath };

    // Content-addressed by hash: an identical file declared twice resolves to
    // the same path. Skip the write rather than erroring on the now-read-only
    // file — the evidence already on disk is, by construction, identical.
    const alreadyExists = await access(evidencePath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);

    if (!alreadyExists) {
      await writeFile(evidencePath, JSON.stringify(stored, null, 2), 'utf8');
      await chmod(evidencePath, 0o444);
    }

    return stored;
  }
}
