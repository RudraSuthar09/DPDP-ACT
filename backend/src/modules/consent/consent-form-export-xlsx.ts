import ExcelJS from 'exceljs';

/**
 * A consent form's submissions, as a spreadsheet — the DASHBOARD export.
 *
 * WHAT IT CAN AND CANNOT CONTAIN, said plainly in the sheet itself.
 *
 * This backend has never held a submitted field VALUE. Values go from the
 * respondent's browser into the client's own storage (Central DPDP Storage,
 * and any Gateway folder a field is pointed at); the only server-side copy is
 * an encrypted relay row that is nulled the moment the Gateway acknowledges
 * it. So this export carries everything the platform is authoritative about —
 * when each submission arrived, who it was (where a Customer Name field was
 * configured), what was consented to, which files were collected, and whether
 * delivery succeeded — and marks every text value as held on the client's own
 * Gateway rather than leaving a column mysteriously blank.
 *
 * The export with values in it is built by the Gateway, in the authorized
 * folder, because that is the only place the values exist. See
 * ConsentFormExportService.
 *
 * One row per submission. Rendered with exceljs, the same library and the
 * same shape as the RoPA export (modules/inventory/ropa-xlsx.ts) — not a
 * second spreadsheet mechanism.
 */

/** Text shown in a cell for a value this platform does not hold. Not an
 *  error and not an empty cell: an empty cell reads as "nothing was
 *  submitted", which would be a lie. */
export const VALUE_HELD_ON_GATEWAY = 'Stored on your own folder';

export interface ExportSubmission {
  submittedAt: Date;
  channel: string;
  /** The Customer Name field's value where the form configured one. Already
   *  resolved metadata (data_principals.display_name) — never an identifier
   *  and never a hash. */
  customerName: string | null;
  /** granted/declined per consent item, keyed by purpose name. */
  answers: Array<{ purposeName: string; granted: boolean }>;
  /** Files collected, keyed by field label. Metadata only. */
  files: Array<{ fieldLabel: string; filename: string; byteSize: number; contentType: string; destination: string | null }>;
  deliveryState: string;
}

export interface ExportField {
  label: string;
  /** Upload fields get a filename/size cell; text fields get the
   *  held-elsewhere note. */
  isFile: boolean;
}

const DELIVERY_LABELS: Record<string, string> = {
  delivered: 'Saved',
  pending: 'Waiting',
  partially_delivered: 'Partly saved',
  failed: 'Failed',
};

export async function renderSubmissionsXlsx(input: {
  organisationName: string;
  formName: string;
  generatedAt: Date;
  /** The form's CURRENT field list, in display order. Column order comes from
   *  the form, not from the submissions, so every row lines up even when
   *  older submissions predate a newer field. */
  fields: ExportField[];
  /** Consent item names, in the form's own order. */
  purposeNames: string[];
  submissions: ExportSubmission[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DPDP Compliance Platform';
  workbook.created = input.generatedAt;

  const sheet = workbook.addWorksheet('Submissions', { views: [{ state: 'frozen', ySplit: 4 }] });

  const headers = [
    'Submitted at',
    'Submitted through',
    'Customer name',
    ...input.purposeNames.map((p) => `Consent: ${p}`),
    ...columnHeaders(input.fields),
    'Storage',
  ];
  const lastCol = columnLetter(headers.length);

  sheet.mergeCells(`A1:${lastCol}1`);
  sheet.getCell('A1').value = input.organisationName;
  sheet.getCell('A1').font = { bold: true, size: 14 };

  sheet.mergeCells(`A2:${lastCol}2`);
  sheet.getCell('A2').value = `Consent form submissions — ${input.formName}`;
  sheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF444444' } };

  sheet.mergeCells(`A3:${lastCol}3`);
  sheet.getCell('A3').value =
    `Generated ${input.generatedAt.toLocaleString()} — ${input.submissions.length} submission(s), ` +
    'read live at generation time. Answers given on the form are stored in your own folder, not in DPDP, ' +
    `so those columns show "${VALUE_HELD_ON_GATEWAY}".`;
  sheet.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF888888' } };

  const headerRow = sheet.getRow(4);
  headerRow.values = headers;
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', wrapText: true };

  for (const s of input.submissions) {
    const byPurpose = new Map(s.answers.map((a) => [a.purposeName, a.granted]));
    const byLabel = new Map(s.files.map((f) => [f.fieldLabel, f]));
    sheet.addRow([
      s.submittedAt,
      s.channel === 'widget' ? 'Website' : 'Shared link',
      // A missing name is blank, not invented. The form may not configure one.
      s.customerName ?? '',
      ...input.purposeNames.map((p) => {
        const granted = byPurpose.get(p);
        // Absent means this submission predates the consent item (or it was
        // added later) — not a decline.
        return granted === undefined ? '' : granted ? 'Yes' : 'No';
      }),
      ...input.fields.flatMap((f) => {
        if (!f.isFile) return [VALUE_HELD_ON_GATEWAY];
        const file = byLabel.get(f.label);
        return file
          ? [file.filename, `${Math.round(file.byteSize / 1024)} KB`, file.contentType, file.destination ?? '']
          : ['', '', '', ''];
      }),
      DELIVERY_LABELS[s.deliveryState] ?? s.deliveryState,
    ]);
  }

  sheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm';
  autoSize(sheet, headers.length);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Column headers for the form's fields.
 *
 * An upload field becomes FOUR columns (name, size, type, destination) rather
 * than one, because "links or filenames with associated file metadata" is four
 * facts and cramming them into one cell makes the sheet unusable for sorting.
 *
 * DUPLICATE LABELS are disambiguated with a numeric suffix. A form owner may
 * legitimately have two fields called "Photo", and Excel tolerates duplicate
 * header text but a reader cannot, so the second becomes "Photo (2)".
 */
function columnHeaders(fields: ExportField[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const f of fields) {
    const n = (seen.get(f.label) ?? 0) + 1;
    seen.set(f.label, n);
    const label = n === 1 ? f.label : `${f.label} (${n})`;
    if (f.isFile) {
      out.push(`${label} — file`, `${label} — size`, `${label} — type`, `${label} — saved to`);
    } else {
      out.push(label);
    }
  }
  return out;
}

/** Excel column letters, for the merged title rows. Handles beyond Z, which a
 *  form with a dozen upload fields reaches easily. */
function columnLetter(n: number): string {
  let out = '';
  let i = n;
  while (i > 0) {
    const rem = (i - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    i = Math.floor((i - 1) / 26);
  }
  return out;
}

/** Width from the widest cell, capped — so a long notice does not produce a
 *  column nobody can scroll past. */
function autoSize(sheet: ExcelJS.Worksheet, columnCount: number): void {
  for (let c = 1; c <= columnCount; c += 1) {
    const column = sheet.getColumn(c);
    let widest = 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.value instanceof Date ? 16 : String(cell.value ?? '').length;
      widest = Math.max(widest, typeof text === 'number' ? text : text);
    });
    column.width = Math.min(widest + 2, 42);
  }
}
