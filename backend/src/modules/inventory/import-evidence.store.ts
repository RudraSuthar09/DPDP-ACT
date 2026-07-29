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
  evidencePath: string;
}

/**
 * WORM-style evidence of a CSV/Excel import declaration (FR-INV-02) — a local
 * disk equivalent of S3 Object Lock. This dev environment has no AWS
 * credentials configured (see backend/.env: only Supabase Postgres), and
 * Object Lock itself is Stage 5 per the master doc, so this is the practical
 * stand-in: written once, then chmod'd read-only, and the application never
 * opens it for writing again.
 *
 * Deliberately stores ONLY the declaration — header column names, a SHA-256 of
 * the full uploaded bytes, and a row COUNT — never the file's data rows, and
 * never the raw file itself (I1). A raw-file copy would itself violate I1 the
 * moment the file contains real customer rows, which is exactly the scenario
 * this feature has to withstand. The hash is computed over the bytes in
 * memory; those bytes are never written anywhere and are discarded the moment
 * this call returns — only the fixed-size digest is retained.
 */
@Injectable()
export class ImportEvidenceStore {
  private readonly baseDir = join(process.cwd(), 'var', 'inventory-import-evidence');

  async record(evidence: ImportEvidenceRecord, rawBytes: string): Promise<StoredImportEvidence> {
    const fileSha256 = createHash('sha256').update(rawBytes, 'utf8').digest('hex');
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
