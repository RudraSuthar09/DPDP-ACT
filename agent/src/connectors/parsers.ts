import * as XLSX from 'xlsx';

/**
 * CSV + XLSX parsing, INSIDE the Gateway. Raw rows produced here live only in
 * this process's memory for the duration of one request and are handed straight
 * to the authorized browser — they are never persisted, never logged, never sent
 * to Azure. SheetJS parses both formats.
 */

export interface ParsedRows {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

/** Hard caps — a connector never loads an unbounded file/row-set into memory. */
export const MAX_ROWS = 5000;

function sheetToRows(sheet: XLSX.WorkSheet, maxRows: number): ParsedRows {
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  const headers = (matrix[0] ?? []).map((h) => String(h));
  const body = matrix.slice(1);
  const truncated = body.length > maxRows;
  const rows = body.slice(0, maxRows).map((r) => r.map((c) => String(c ?? '')));
  return { headers, rows, truncated };
}

export function parseCsv(buffer: Buffer, maxRows: number = MAX_ROWS): ParsedRows {
  const wb = XLSX.read(buffer.toString('utf8'), { type: 'string' });
  const first = wb.SheetNames[0];
  if (!first) return { headers: [], rows: [], truncated: false };
  return sheetToRows(wb.Sheets[first]!, maxRows);
}

export function parseXlsx(buffer: Buffer, maxRows: number = MAX_ROWS): ParsedRows {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (!first) return { headers: [], rows: [], truncated: false };
  return sheetToRows(wb.Sheets[first]!, maxRows);
}
