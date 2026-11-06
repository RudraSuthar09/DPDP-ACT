import ExcelJS from 'exceljs';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConsentFormExportService, exportFilename } from './consent-form-export.service';
import { VALUE_HELD_ON_GATEWAY, renderSubmissionsXlsx } from './consent-form-export-xlsx';
import { parseExportDestination } from './consent-forms.dto';

/**
 * The submissions spreadsheet.
 *
 * Two things these tests exist to hold in place. First, what the sheet may
 * contain: this platform has never held a submitted field value, so the
 * export says so in the cell rather than leaving it blank, and it carries no
 * internal id of any kind. Second, where it may be saved: only into a
 * location an administrator granted WRITE on, revalidated at the moment of
 * use rather than trusted from the request.
 */

const FORM = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOT = '33333333-3333-4333-8333-333333333333';

async function readSheet(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0]!;
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values = row.values as unknown[];
    rows.push(values.slice(1).map((v) => (v instanceof Date ? v.toISOString() : String(v ?? ''))));
  });
  return rows;
}

describe('rendering the spreadsheet', () => {
  const base = {
    organisationName: 'Hotel Sunrise',
    formName: 'Guest check-in',
    generatedAt: new Date('2026-11-01T10:00:00.000Z'),
    purposeNames: ['Marketing emails'],
    fields: [
      { label: 'Full name', isFile: false },
      { label: 'Passport photo', isFile: true },
    ],
    submissions: [
      {
        submittedAt: new Date('2026-10-30T09:15:00.000Z'),
        channel: 'link',
        customerName: 'Asha Rao',
        answers: [{ purposeName: 'Marketing emails', granted: true }],
        files: [
          {
            fieldLabel: 'Passport photo',
            filename: 'Passport photo - sub-1 - fld-1.jpg',
            byteSize: 204800,
            contentType: 'image/jpeg',
            destination: 'Guest records',
          },
        ],
        deliveryState: 'delivered',
      },
    ],
  };

  it('has one row per submission, with headers from the form\'s own labels', async () => {
    const rows = await readSheet(await renderSubmissionsXlsx(base));
    const header = rows[3]!;
    expect(header[0]).toBe('Submitted at');
    expect(header).toContain('Customer name');
    expect(header).toContain('Consent: Marketing emails');
    expect(header).toContain('Full name');
    expect(header).toContain('Passport photo — file');
    // Four rows of preamble/header, then exactly one data row.
    expect(rows).toHaveLength(5);
  });

  it('says where a text value actually lives instead of leaving a blank cell', async () => {
    const rows = await readSheet(await renderSubmissionsXlsx(base));
    expect(rows[4]).toContain(VALUE_HELD_ON_GATEWAY);
    // ...and the preamble explains it, so a reader is not left guessing.
    expect(rows[2]!.join(' ')).toContain(VALUE_HELD_ON_GATEWAY);
  });

  it('lists a file by name, size, type and destination — never its bytes', async () => {
    const buffer = await renderSubmissionsXlsx(base);
    const rows = await readSheet(buffer);
    const row = rows[4]!;
    expect(row).toContain('Passport photo - sub-1 - fld-1.jpg');
    expect(row).toContain('200 KB');
    expect(row).toContain('image/jpeg');
    expect(row).toContain('Guest records');
    // A base64 image would show up as a long opaque run; nothing of the kind
    // is in the sheet.
    expect(row.join(' ')).not.toMatch(/[A-Za-z0-9+/]{120,}/);
  });

  it('carries no internal id: not a form id, a root id, a submission id or a subject ref', async () => {
    const rows = await readSheet(await renderSubmissionsXlsx(base));
    const all = rows.flat().join(' ');
    expect(all).not.toContain(FORM);
    expect(all).not.toContain(ROOT);
    // The generated FILENAME legitimately contains the submission id (that is
    // what makes a file unique on disk) — but no id appears as a column.
    expect(all).not.toMatch(/subject_ref|subjectRef/);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  });

  it('disambiguates duplicate field labels instead of producing two identical headers', async () => {
    const rows = await readSheet(
      await renderSubmissionsXlsx({
        ...base,
        fields: [
          { label: 'Photo', isFile: true },
          { label: 'Photo', isFile: true },
        ],
      }),
    );
    const header = rows[3]!;
    expect(header).toContain('Photo — file');
    expect(header).toContain('Photo (2) — file');
  });

  it('handles a submission with nothing in it: no name, no files, an answer it predates', async () => {
    const rows = await readSheet(
      await renderSubmissionsXlsx({
        ...base,
        purposeNames: ['Marketing emails', 'Added later'],
        submissions: [
          {
            submittedAt: new Date('2026-10-01T00:00:00.000Z'),
            channel: 'widget',
            customerName: null,
            answers: [{ purposeName: 'Marketing emails', granted: false }],
            files: [],
            deliveryState: 'pending',
          },
        ],
      }),
    );
    const row = rows[4]!;
    expect(row).toContain('Website');
    expect(row).toContain('No'); // declined
    // The consent item this submission predates is blank, NOT reported as a
    // decline — a missing answer and a refusal are different facts.
    expect(row.filter((c) => c === 'No')).toHaveLength(1);
    expect(row).toContain('Waiting');
  });

  it('survives special characters in labels and names without breaking the workbook', async () => {
    const buffer = await renderSubmissionsXlsx({
      ...base,
      formName: 'Guest "check-in" <2026> & co',
      fields: [{ label: 'Name =SUM(A1:A9) ü 😀', isFile: false }],
      submissions: [{ ...base.submissions[0]!, customerName: 'O\'Brien <script>' }],
    });
    const rows = await readSheet(buffer);
    expect(rows[3]!.join(' ')).toContain('=SUM(A1:A9)');
    expect(rows[4]!.join(' ')).toContain("O'Brien <script>");
  });

  it('a form with many fields still gets correct merged-title columns (past Z)', async () => {
    const many = Array.from({ length: 12 }, (_v, i) => ({ label: `Doc ${i}`, isFile: true }));
    await expect(renderSubmissionsXlsx({ ...base, fields: many })).resolves.toBeInstanceOf(Buffer);
  });

  it('renders an empty form without a sheet full of nothing', async () => {
    const rows = await readSheet(await renderSubmissionsXlsx({ ...base, submissions: [] }));
    expect(rows).toHaveLength(4); // preamble + header only
    expect(rows[2]!.join(' ')).toContain('0 submission(s)');
  });
});

describe('the download filename', () => {
  it('is built from the form name, with anything that is not plain text stripped', () => {
    expect(exportFilename('Guest check-in', new Date('2026-11-01T00:00:00Z'))).toBe(
      'Guest check-in submissions 2026-11-01.xlsx',
    );
  });

  it('cannot carry a path, a quote or a traversal into a Content-Disposition header', () => {
    const name = exportFilename('../../etc/"passwd"', new Date('2026-11-01T00:00:00Z'));
    expect(name).not.toMatch(/[\\/"]/);
    expect(name).not.toContain('..');
  });

  it('falls back to a usable name when the form name has nothing usable in it', () => {
    expect(exportFilename('«»', new Date('2026-11-01T00:00:00Z'))).toBe('consent-form submissions 2026-11-01.xlsx');
  });
});

describe('choosing where the spreadsheet is saved', () => {
  function service(opts: { roots?: Array<Record<string, unknown>>; form?: Record<string, unknown> | null } = {}) {
    const saved: Array<string | null> = [];
    const annotations: Array<Record<string, unknown>> = [];
    const roots = opts.roots ?? [{ id: ROOT, name: 'Guest records', provider: 'gateway', status: 'active' }];
    const repo = {
      getForm: async () =>
        opts.form === undefined
          ? { id: FORM, name: 'Guest check-in', export_storage_root_id: null }
          : opts.form,
      setExportStorageRoot: async (_id: string, rootId: string | null) => {
        saved.push(rootId);
        return { id: FORM, name: 'Guest check-in', export_storage_root_id: rootId };
      },
      listRows: async () => [],
      listCustomerFields: async () => [],
      listSubmissions: async () => [],
      listSubmissionFiles: async () => [],
    };
    const storage = {
      listRoots: async () => roots,
      getRoot: async (id: string) => {
        const root = roots.find((r) => r.id === id);
        // Tenant scoping is RLS's job: another tenant's id is simply absent.
        if (!root) throw new NotFoundException('Storage root not found.');
        return root;
      },
    };
    const svc = new ConsentFormExportService(
      repo as never,
      storage as never,
      { latestStatuses: async () => new Map(), hasCentralDestination: async () => true } as never,
      { displayNamesFor: async () => new Map() } as never,
      { annotate: (a: Record<string, unknown>) => annotations.push(a) } as never,
    );
    return { svc, saved, annotations };
  }

  it('accepts an authorized writable Gateway folder', async () => {
    const { svc, saved } = service();
    await expect(svc.setExportDestination(FORM, ROOT)).resolves.toMatchObject({ destinationName: 'Guest records' });
    expect(saved).toEqual([ROOT]);
  });

  it('REFUSES a read-only location: a non-gateway root is never a destination', async () => {
    // A read grant is a data_sources row, a different registry entirely — so
    // the only way to attempt one here is an id of a non-gateway root.
    const { svc, saved } = service({
      roots: [{ id: ROOT, name: 'Server mount', provider: 'server', status: 'active' }],
    });
    await expect(svc.setExportDestination(FORM, ROOT)).rejects.toThrow(BadRequestException);
    expect(saved).toEqual([]);
  });

  it('refuses a folder the organisation has removed', async () => {
    const { svc } = service({
      roots: [{ id: ROOT, name: 'Guest records', provider: 'gateway', status: 'tombstoned' }],
    });
    await expect(svc.setExportDestination(FORM, ROOT)).rejects.toThrow(ConflictException);
  });

  it('refuses an id that is not this tenant\'s — indistinguishable from one that does not exist', async () => {
    const { svc } = service();
    await expect(svc.setExportDestination(FORM, OTHER_ROOT)).rejects.toThrow(NotFoundException);
  });

  it('clears the destination with null, leaving download-only', async () => {
    const { svc, saved } = service();
    await expect(svc.setExportDestination(FORM, null)).resolves.toMatchObject({ destinationName: null });
    expect(saved).toEqual([null]);
  });

  it('reports a destination that has since been removed as UNAVAILABLE, not as download-only', async () => {
    const { svc } = service({
      form: { id: FORM, name: 'Guest check-in', export_storage_root_id: ROOT },
      roots: [{ id: ROOT, name: 'Guest records', provider: 'gateway', status: 'tombstoned' }],
    });
    await expect(svc.exportDestination(FORM)).resolves.toEqual({
      storageRootId: ROOT,
      destinationName: 'Guest records',
      available: false,
    });
  });

  it('a form that does not exist is a 404, never a silent success', async () => {
    const { svc } = service({ form: null });
    await expect(svc.setExportDestination(FORM, ROOT)).rejects.toThrow(NotFoundException);
    await expect(svc.renderXlsx(FORM)).rejects.toThrow(NotFoundException);
  });

  it('audits the change with the folder NAME, never its id', async () => {
    const { svc, annotations } = service();
    await svc.setExportDestination(FORM, ROOT);
    const reason = String(annotations.at(-1)!['reason']);
    expect(reason).toContain('Guest records');
    expect(reason).not.toContain(ROOT);
  });

  it('generating an export writes nothing to the submissions it reads', async () => {
    const { svc } = service();
    // The repository stub exposes no write method at all beyond the
    // destination setter; a render that tried to mutate anything would throw.
    await expect(svc.renderXlsx(FORM)).resolves.toMatchObject({ filename: expect.stringContaining('.xlsx') });
  });
});

describe('the destination request body', () => {
  it('takes a UUID, or null to clear', () => {
    expect(parseExportDestination({ storageRootId: ROOT })).toEqual({ storageRootId: ROOT });
    expect(parseExportDestination({ storageRootId: null })).toEqual({ storageRootId: null });
    expect(parseExportDestination({})).toEqual({ storageRootId: null });
  });

  it('refuses anything that is not a UUID, and reads nothing else from the body', () => {
    expect(() => parseExportDestination({ storageRootId: 'Guest records' })).toThrow(BadRequestException);
    expect(() => parseExportDestination({ storageRootId: '../../etc' })).toThrow(BadRequestException);
    expect(() => parseExportDestination('nope')).toThrow(BadRequestException);
    expect(parseExportDestination({ storageRootId: ROOT, tenantId: 'other', path: 'C:\\x' })).toEqual({
      storageRootId: ROOT,
    });
  });
});
