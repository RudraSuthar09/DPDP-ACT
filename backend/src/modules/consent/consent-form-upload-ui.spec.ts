import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSENT_FORM_FILE_KINDS, UPLOAD_MAX_BYTES_CEILING } from '@dpdp/shared';

/**
 * The browser halves of file uploads and the submissions export (frontend
 * logic, asserted here because the frontend has no unit-test runner — same
 * pattern as connected-locations.spec.ts).
 *
 * These are not style checks. Each one pins a property that would be a real
 * defect if it regressed: that the browser's pre-validation is a courtesy and
 * not the control, that a respondent can undo a wrong file, that the export
 * never overwrites, and that an unreachable Gateway is reported as such
 * instead of as a success.
 */
const FRONTEND = join(__dirname, '..', '..', '..', '..', 'frontend', 'src');
const read = (...p: string[]): string => readFileSync(join(FRONTEND, ...p), 'utf8');

describe('the respondent\'s upload control', () => {
  const control = read('app', 'forms', '[slug]', 'FileUploadField.tsx');

  it('tells the respondent what is accepted and how large, before they choose', () => {
    expect(control).toContain('describeUploadKind');
    expect(control).toContain('describeByteSize');
    expect(control).toMatch(/\{kinds\} · up to \{limit\}/);
  });

  it('checks the FILE\'S OWN BYTES, using the same shared inspector as the server', () => {
    expect(control).toContain('inspectUpload');
    // A slice of the head, not the whole file: a 20 MB photo must not be read
    // into memory on a phone to look at twelve bytes.
    expect(control).toContain('picked.slice(0, SNIFF_BYTES)');
    // It must never decide anything from the browser's own guess.
    expect(control).not.toContain('picked.type');
    expect(control).not.toContain('.name.endsWith');
  });

  it('lets a respondent see, replace and remove what they chose', () => {
    expect(control).toContain('{file.name}');
    expect(control).toContain('describeByteSize(file.size)');
    expect(control).toMatch(/onClick=\{\(\) => inputRef\.current\?\.click\(\)\}[\s\S]{0,40}Replace/);
    expect(control).toMatch(/onClick=\{clear\}[\s\S]{0,40}Remove/);
  });

  it('a rejected file does not become the submitted one, and does not linger in the input', () => {
    // reject() clears the parent's state AND the native input, so the browser
    // cannot keep showing a filename next to "not accepted".
    expect(control).toMatch(/function reject[\s\S]{0,300}onPick\(null\)/);
    expect(control).toMatch(/function reject[\s\S]{0,400}inputRef\.current\.value = ''/);
  });

  it('has its own wording for every rejection the shared inspector can return', () => {
    for (const reason of ['TOO_LARGE', 'EMPTY', 'TYPE_NOT_ALLOWED', 'TYPE_UNRECOGNISED']) {
      expect({ reason, present: control.includes(reason) }).toEqual({ reason, present: true });
    }
  });

  it('`required` is released once a file is held, so a replace cannot block submitting', () => {
    expect(control).toContain('required={required && !file}');
  });
});

describe('the builder\'s File upload field', () => {
  const builder = read('app', '(app)', 'consent', 'forms', '[id]', 'page.tsx');

  it('offers the field type in plain words, with the older types marked as older', () => {
    expect(builder).toContain('File upload (photo or PDF)');
    expect(builder).toContain('PDF (older type)');
    expect(builder).toContain('Excel (older type)');
  });

  it('configures exactly the three things, and only for a file field', () => {
    for (const kind of CONSENT_FORM_FILE_KINDS) {
      expect({ kind, present: builder.includes(`value="${kind}"`) }).toEqual({ kind, present: true });
    }
    expect(builder).toContain('Largest file allowed');
    expect(builder).toContain('Instructions for the customer (optional)');
    // The configuration block, and the body it sends, are both gated on the
    // type — the backend refuses this configuration on any other field.
    expect(builder).toContain("{cfType === 'file' && (");
    expect(builder).toContain("...(cfType === 'file'");
  });

  it('offers no size above the ceiling the server and the schema both enforce', () => {
    const choices = /UPLOAD_SIZE_CHOICES_MB = \[([^\]]+)\]/.exec(builder);
    expect(choices).not.toBeNull();
    const mbs = choices![1]!.split(',').map((n) => Number(n.trim()));
    expect(Math.max(...mbs) * 1024 * 1024).toBeLessThanOrEqual(UPLOAD_MAX_BYTES_CEILING);
  });
});

describe('the submissions export in the management page', () => {
  const page = read('app', '(app)', 'consent', 'forms', '[id]', 'page.tsx');

  it('offers the download, and says plainly where typed answers actually are', () => {
    expect(page).toContain('Download as Excel');
    expect(page).toMatch(/kept in your own folder, not in DPDP/);
  });

  it('is gated on the manage roles, like every other change on this page', () => {
    expect(page).toMatch(/\{canManage && \(\s*<>\s*<button type="button" disabled=\{exportBusy\}/);
  });

  it('downloads by POST, because taking a submissions register is audited', () => {
    expect(page).toMatch(/submissions\/export`[\s\S]{0,120}method: 'POST'/);
  });

  it('offers only writable locations as a destination, and never asks for an id', () => {
    // gwRoots is active gateway-provider roots only — a read grant is a
    // data_sources row and cannot appear here.
    expect(page).toContain('{gwRoots.map((r) => (');
    expect(page).toContain('<option value="">Download only</option>');
    expect(page).not.toMatch(/placeholder="[^"]*(root|source) ?id/i);
  });

  it('NEVER overwrites an existing spreadsheet in the folder', () => {
    // writeStorageFile defaults overwrite to false, and this caller does not
    // pass it — so the Gateway refuses rather than replacing a file.
    expect(page).toContain('writeStorageFile(session, {');
    expect(page).not.toMatch(/overwrite:\s*true/);
  });

  it('reports an unreachable Gateway as a failure, never as a save', () => {
    // The session is opened BEFORE anything claims success, and the failure
    // from opening it is what the customer is shown.
    expect(page).toMatch(/openGatewayStorageSession\(rootId\)[\s\S]{0,400}setExportNotice/);
    expect(page).toContain('GatewayStorageSessionError');
    expect(page).toMatch(/setExportError\([\s\S]{0,200}Could not save the spreadsheet to that folder/);
  });

  it('generates the export FRESH for the folder copy, never reusing a cached blob', () => {
    expect(page).toMatch(/fetchBlob\(`\/consent\/forms\/\$\{id\}\/submissions\/export`\)/);
  });

  it('shows a removed destination as unavailable rather than silently downgrading', () => {
    expect(page).toContain('exportDestination.available');
    expect(page).toContain('no longer available');
  });
});

describe('the Gateway write helper', () => {
  const lib = read('lib', 'gateway-storage-session.ts');

  it('defaults to NOT overwriting — a caller has to ask for it explicitly', () => {
    expect(lib).toContain("overwrite: input.overwrite === true");
  });

  it('goes through the existing session-bound storage plane, not a new route', () => {
    expect(lib).toContain("storagePost(session, '/storage/write'");
  });
});
