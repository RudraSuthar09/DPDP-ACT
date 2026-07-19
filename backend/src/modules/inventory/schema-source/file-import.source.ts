import type { SchemaColumn, SchemaConstraint, SchemaSource } from '@dpdp/shared';

export interface FileImportOptions {
  /** The uploaded file's name — retained as evidence of what was declared (P2). */
  fileName: string;
  /** The logical table these columns belong to. */
  tableName: string;
  /** The file's raw text. Only its HEADER is ever read; see the constructor. */
  csvText: string;
}

/**
 * S4 implementation #2 — FileImport (ingestion path P2). A small business uploads
 * an Excel/CSV export; we discover its COLUMN NAMES from the header row.
 *
 * This is where invariant I1 is most vividly a type-level guarantee. The uploaded
 * file may be full of real customer data — and this source structurally cannot
 * surface a single value of it, for two independent reasons:
 *
 *   1. The interface has no readRows(). There is no method whose job is to return
 *      a row, so no caller can ask for one.
 *   2. This constructor parses ONLY the header line and throws the rest away. The
 *      data rows are never stored on the instance, never parsed, never crossed a
 *      boundary. Even code inside this class has nothing to leak.
 *
 * (The same principle scales to the later connectors: the on-prem agent and the
 * Mongo driver infer field NAMES and discard values before they leave the client's
 * process — the interface just makes it impossible to do otherwise.)
 */
export class FileImportSchemaSource implements SchemaSource {
  readonly kind = 'file_import' as const;

  private readonly fileName: string;
  private readonly tableName: string;
  private readonly header: string[];

  constructor(options: FileImportOptions) {
    this.fileName = options.fileName;
    this.tableName = options.tableName;
    // Read the header, discard everything after it. options.csvText is NOT stored,
    // so the data rows do not live on this object at all (I1).
    this.header = parseHeaderRow(options.csvText);
  }

  async testConnection(): Promise<boolean> {
    return this.header.length > 0;
  }

  async listSchemas(): Promise<string[]> {
    // A single flat file maps to one logical "imported" schema.
    return ['imported'];
  }

  async listTables(): Promise<string[]> {
    return [this.tableName];
  }

  async listColumns(): Promise<SchemaColumn[]> {
    // Names only. A flat file carries no type information, so type is 'unknown'
    // and a human confirms it later — the platform advises, never decides.
    return this.header.map((name) => ({
      name,
      type: 'unknown',
      nullable: true,
      comment: `Imported from ${this.fileName}`,
    }));
  }

  async listConstraints(): Promise<SchemaConstraint[]> {
    // A flat file declares no constraints.
    return [];
  }
}

/**
 * Parse ONLY the first non-empty line into column names. Minimal CSV: split on
 * commas, trim, strip surrounding quotes. Deliberately not a full CSV parser —
 * that would parse the data rows, and the whole point is that we never touch them.
 */
function parseHeaderRow(csvText: string): string[] {
  const firstLine = csvText.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) {
    return [];
  }
  return firstLine
    .split(',')
    .map((cell) => cell.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter((name) => name.length > 0);
}
