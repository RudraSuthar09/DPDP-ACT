import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { classifyPii, type PiiConfidence } from './pii-classifier';
import { createSchemaSource } from './schema-source/schema-source.factory';
import {
  RegisterEntriesRepository,
  type RegisterEntryRow,
  type RegisterEntryVersionRow,
} from './register-entries.repository';
import { EntryPurposesRepository } from './entry-purposes.repository';
import { ImportEvidenceStore } from './import-evidence.store';
import type { ColumnMappingInput, ImportLegalBasis } from './register-import.dto';

export interface PreviewColumn {
  name: string;
  suggestedCategory: string | null;
  confidence: PiiConfidence | null;
}

export interface CommitInput {
  fileName: string;
  tableName: string;
  csvText: string;
  purpose: string;
  legalBasis: ImportLegalBasis;
  storageLocation: string;
  retentionPeriod: string;
  columns: ColumnMappingInput[];
}

export interface CommitResult {
  evidence: { fileSha256: string; headerColumns: string[]; rowCountDeclared: number };
  entries: Array<{ id: string; category: string; versionNumber: number }>;
}

/**
 * CSV/Excel import for the Data Inventory register (FR-INV-02, ingestion path
 * P2), built on Seam S4's FileImport — the same seam ManualEntry uses. Two
 * steps: preview (parse the header, propose a mapping — nothing persisted)
 * and commit (validate the human-confirmed mapping, then create register
 * entries through RegisterEntriesRepository.create() — the EXACT method the
 * guided wizard calls, so an imported entry is indistinguishable from a
 * manually-entered one and gets the same version-1 row and the same audit
 * path (R3: no parallel write path into these tables).
 */
@Injectable()
export class RegisterImportService {
  constructor(
    private readonly repo: RegisterEntriesRepository,
    private readonly purposes: EntryPurposesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    private readonly evidence: ImportEvidenceStore,
  ) {}

  /**
   * Discover column NAMES via the FileImport source, which parses only the
   * header row and never stores the rest (I1), and suggest a PII category per
   * column. Pure computation — nothing is persisted here.
   */
  async preview(fileName: string, tableName: string, csvText: string): Promise<PreviewColumn[]> {
    const source = createSchemaSource({ kind: 'file_import', fileName, tableName, csvText });
    if (!(await source.testConnection())) {
      throw new BadRequestException('The file has no header row to import.');
    }
    const columns = await source.listColumns(tableName);
    return columns.map((c) => {
      const suggestion = classifyPii(c.name);
      return {
        name: c.name,
        suggestedCategory: suggestion?.category ?? null,
        confidence: suggestion?.confidence ?? null,
      };
    });
  }

  /**
   * Validate the confirmed mapping against the file's REAL header (guards
   * against a stale or tampered mapping), record WORM evidence of the
   * declaration, then create one register entry per mapped column. One audit
   * entry summarises the whole batch — looping RegisterService.create() would
   * instead overwrite its own annotation on every iteration (the interceptor
   * writes exactly one row per request), so this calls the REPOSITORY
   * directly and annotates once at the end with every created entry listed.
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    const ctx = this.tenantContext.getOrThrow();

    const source = createSchemaSource({
      kind: 'file_import',
      fileName: input.fileName,
      tableName: input.tableName,
      csvText: input.csvText,
    });
    const actualColumns = await source.listColumns(input.tableName);
    const actualNames = new Set(actualColumns.map((c) => c.name));

    const unknownColumns = input.columns
      .map((c) => c.name)
      .filter((name) => !actualNames.has(name));
    if (unknownColumns.length > 0) {
      throw new BadRequestException(
        `These mapped columns were not found in the file's header: ${unknownColumns.join(', ')}.`,
      );
    }
    const seen = new Set<string>();
    for (const { name } of input.columns) {
      if (seen.has(name)) {
        throw new BadRequestException(`Column "${name}" is mapped more than once.`);
      }
      seen.add(name);
    }

    const stored = await this.evidence.record(
      {
        tenantId: ctx.tenantId,
        fileName: input.fileName,
        tableName: input.tableName,
        headerColumns: actualColumns.map((c) => c.name),
        rowCountDeclared: countDeclaredRows(input.csvText),
        importedAt: new Date().toISOString(),
        importedBy: ctx.userId,
      },
      input.csvText,
    );

    const created: Array<{ entry: RegisterEntryRow; version: RegisterEntryVersionRow }> = [];
    for (const column of input.columns) {
      const one = await this.repo.create(
        {
          category: column.category,
          description:
            column.description ?? `Imported from "${input.fileName}" (column: ${column.name})`,
          storageLocation: input.storageLocation,
        },
        ctx.userId,
      );
      created.push(one);
      // One shared purpose/legal-basis/retention applied to every column this
      // batch creates (FR-INV-05) — the same "shared details" fields the
      // import mapping screen collects once for the whole file.
      await this.purposes.create(
        one.entry.id,
        {
          purposeName: input.purpose,
          description: null,
          legalBasis: input.legalBasis,
          legalBasisNote: null,
          retentionPeriod: input.retentionPeriod,
        },
        ctx.userId,
      );
    }

    this.audit.annotate({
      targetType: 'inventory_import_batch',
      targetId: stored.fileSha256,
      reason: `Imported ${created.length} data element(s) from "${input.fileName}" (CSV/Excel import, FR-INV-02)`,
      afterState: {
        fileName: input.fileName,
        tableName: input.tableName,
        fileSha256: stored.fileSha256,
        headerColumns: stored.headerColumns,
        rowCountDeclared: stored.rowCountDeclared,
        evidencePath: stored.evidencePath,
        createdEntries: created.map((c) => ({ id: c.entry.id, category: c.version.category })),
      },
    });

    return {
      evidence: {
        fileSha256: stored.fileSha256,
        headerColumns: stored.headerColumns,
        rowCountDeclared: stored.rowCountDeclared,
      },
      entries: created.map((c) => ({
        id: c.entry.id,
        category: c.version.category,
        versionNumber: c.version.version_number,
      })),
    };
  }
}

/** Counts non-empty DATA lines (total minus the header) — a NUMBER, never the
 *  content of those lines (I1). */
function countDeclaredRows(csvText: string): number {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return Math.max(0, lines.length - 1);
}
