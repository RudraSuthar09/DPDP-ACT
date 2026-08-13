/**
 * Browser-LOCAL Excel/CSV parsing (Phase 2, Mode-B raw-data proof).
 *
 * Everything in this file runs in the user's browser and touches only a File the
 * user themselves selected. Nothing here uploads, fetches, posts, or transmits
 * the file or its contents anywhere — there is no network call in this module at
 * all. The parsed result is returned to the caller (the viewer component), held
 * in that component's local state, and discarded when the viewer unmounts.
 *
 * Parser: SheetJS (`xlsx`), which parses both .xlsx and .csv entirely in memory.
 */
import * as XLSX from 'xlsx';

/** POC bound. Large files belong to a later phase; this also caps the memory a
 *  single view can hold and keeps parsing responsive. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Cap the rows we materialise for display, so a huge sheet cannot lock the tab.
 *  The count reported for audit is the number actually read. */
export const MAX_DISPLAY_ROWS = 5000;

export interface ParsedFile {
  headers: string[];
  rows: string[][];
  /** True if the file had more data rows than MAX_DISPLAY_ROWS (rows truncated). */
  truncated: boolean;
}

/** A deliberately generic, content-free error. Parser/validation messages must
 *  NEVER echo file contents (a malformed row could be a customer record). */
export class LocalFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFileError';
  }
}

const ALLOWED_EXT = ['.csv', '.xlsx'];

export function validateFile(file: File): void {
  const lower = file.name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (!ALLOWED_EXT.includes(ext)) {
    throw new LocalFileError('Only .csv and .xlsx files are supported.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new LocalFileError(`File is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit for this preview.`);
  }
  if (file.size === 0) {
    throw new LocalFileError('The file is empty.');
  }
}

/**
 * Parse a user-selected CSV/XLSX File into headers + rows, entirely in-browser.
 * Throws a sanitized LocalFileError on any failure — the caught parser error is
 * discarded, never surfaced, because it can quote raw content.
 */
export async function parseLocalFile(file: File): Promise<ParsedFile> {
  validateFile(file);
  const isCsv = file.name.toLowerCase().endsWith('.csv');

  let workbook: XLSX.WorkBook;
  try {
    if (isCsv) {
      const text = await file.text();
      workbook = XLSX.read(text, { type: 'string' });
    } else {
      const buf = await file.arrayBuffer();
      workbook = XLSX.read(buf, { type: 'array' });
    }
  } catch {
    // The caught error is DISCARDED — it can contain a fragment of the file.
    throw new LocalFileError('Could not read this file. Make sure it is a valid CSV or Excel file.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new LocalFileError('The file has no sheets or rows to display.');
  const sheet = workbook.Sheets[sheetName];

  let matrix: unknown[][];
  try {
    // header:1 → array-of-arrays; raw:false → formatted strings; defval → blanks.
    matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: false, defval: '' });
  } catch {
    throw new LocalFileError('Could not parse the file contents.');
  }

  if (matrix.length === 0) throw new LocalFileError('The file has no rows.');
  const headers = (matrix[0] ?? []).map((h) => String(h ?? '').trim());
  const dataRows = matrix.slice(1);
  const truncated = dataRows.length > MAX_DISPLAY_ROWS;
  const rows = dataRows.slice(0, MAX_DISPLAY_ROWS).map((r) => headers.map((_, i) => String(r[i] ?? '')));

  return { headers, rows, truncated };
}
