import ExcelJS from 'exceljs';
import type { RopaEntryRow } from './ropa.repository';

/**
 * FR-INV-09 — the Record of Processing Activities, rendered as XLSX via
 * exceljs (pure JS, no native deps — nothing already in this repo can write
 * a correct OOXML/zip workbook, and hand-rolling one risks silent corruption
 * for a regulator-facing artefact, so a real library was judged worth it).
 *
 * One row per (element x purpose) — the standard flat/denormalised RoPA
 * spreadsheet shape, so a reviewer can sort/filter by legal basis or purpose
 * directly. An element with zero recorded purposes still gets ONE row (with
 * purpose columns blank) so it is never silently dropped from the export.
 */

const LEGAL_BASIS_LABELS: Record<string, string> = {
  consent: 'Consent',
  legitimate_use: 'Legitimate use',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
  other: 'Other',
};

const PII_DECISION_LABELS: Record<string, string> = {
  accepted: 'Confirmed',
  rejected: 'Reviewed — not classified as PII',
  undecided: 'Not yet reviewed',
};

export async function renderRopaXlsx(input: {
  organisationName: string;
  generatedAt: Date;
  entries: RopaEntryRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DPDP Compliance Platform';
  workbook.created = input.generatedAt;

  const sheet = workbook.addWorksheet('Record of Processing Activities', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  sheet.mergeCells('A1:K1');
  sheet.getCell('A1').value = input.organisationName;
  sheet.getCell('A1').font = { bold: true, size: 14 };

  sheet.mergeCells('A2:K2');
  sheet.getCell('A2').value = 'Record of Processing Activities';
  sheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF444444' } };

  sheet.mergeCells('A3:K3');
  sheet.getCell('A3').value =
    `Generated ${input.generatedAt.toLocaleString()} — reflects current data at generation time, not a cached snapshot.`;
  sheet.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF888888' } };

  const headerRow = sheet.getRow(4);
  const headers = [
    'Category',
    'Description',
    'Storage location',
    'Purpose',
    'Legal basis',
    'Legal basis note',
    'Retention period',
    'Systems',
    'Vendors / recipients',
    'PII classification',
    'PII review status',
  ];
  headerRow.values = headers;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3B52' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  sheet.columns = [
    { key: 'category', width: 26 },
    { key: 'description', width: 30 },
    { key: 'storageLocation', width: 28 },
    { key: 'purpose', width: 26 },
    { key: 'legalBasis', width: 16 },
    { key: 'legalBasisNote', width: 24 },
    { key: 'retentionPeriod', width: 26 },
    { key: 'systems', width: 30 },
    { key: 'vendors', width: 30 },
    { key: 'piiClassification', width: 20 },
    { key: 'piiStatus', width: 22 },
  ];

  let rowIndex = 5;
  for (const entry of input.entries) {
    const systemsText = entry.systems
      .map((s) => `${s.name} (${s.systemType}${s.hostingLocation ? `, ${s.hostingLocation}` : ''})`)
      .join('; ');
    const vendorsText = entry.vendors
      .map((v) => `${v.name}${v.country ? ` (${v.country})` : ''}${v.transferNotes ? ` — ${v.transferNotes}` : ''}`)
      .join('; ');
    const piiClassification = entry.pii_category
      ? `${entry.pii_category}${entry.pii_confidence ? ` (${entry.pii_confidence})` : ''}`
      : '—';
    const piiStatus = PII_DECISION_LABELS[entry.pii_decision] ?? entry.pii_decision;

    const purposes = entry.purposes.length > 0 ? entry.purposes : [null];
    for (const purpose of purposes) {
      const row = sheet.getRow(rowIndex);
      row.values = {
        category: entry.category,
        description: entry.description ?? '',
        storageLocation: entry.storage_location,
        purpose: purpose?.purposeName ?? '',
        legalBasis: purpose ? (LEGAL_BASIS_LABELS[purpose.legalBasis] ?? purpose.legalBasis) : '',
        legalBasisNote: purpose?.legalBasisNote ?? '',
        retentionPeriod: purpose?.retentionPeriod ?? '',
        systems: systemsText,
        vendors: vendorsText,
        piiClassification,
        piiStatus,
      };
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
      rowIndex += 1;
    }
  }

  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
