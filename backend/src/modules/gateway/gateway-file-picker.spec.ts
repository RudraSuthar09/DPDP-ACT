import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCreateDataSource } from '../datasource/data-source.dto';

/**
 * Data Sources -> "Select files" (frontend logic, run here because the
 * frontend has no unit-test runner; loaded at runtime, outside the backend's
 * rootDir). A picked file becomes an ORDINARY data source whose location is
 * recorded in the existing non-secret connectionHint.
 */
const FRONTEND = join(__dirname, '..', '..', '..', '..', 'frontend', 'src');
type Ref = { src: string; dir: string[]; file: string; size: number | null };
const lib = jest.requireActual(join(FRONTEND, 'lib', 'gateway-file-source.ts')) as {
  encodeGatewayFileHint: (r: Ref) => string;
  decodeGatewayFileHint: (h: string | null | undefined) => Ref | null;
  sourceKindForFile: (n: string) => string;
  formatLocation: (r: { dir: string[] }) => string;
  formatBytes: (b: number | null) => string;
  isGatewayFolderSource: (s: { status: string; dataAccessMode: string; sourceKind: string; connectionHint?: string | null }) => boolean;
};

const REF: Ref = { src: '0b6a6b9e-1d3c-4a71-9c6f-1f0e0d0c0b0a', dir: ['Exports', '2024'], file: 'q1 customers.csv', size: 1234 };

describe('recording a picked file in the existing connectionHint', () => {
  it('round-trips exactly', () => {
    expect(lib.decodeGatewayFileHint(lib.encodeGatewayFileHint(REF))).toEqual(REF);
  });

  it('is accepted by the backend\'s existing data-source validation (no backend change needed)', () => {
    const parsed = parseCreateDataSource({ name: REF.file, sourceKind: 'csv', connectionHint: lib.encodeGatewayFileHint(REF) });
    expect(parsed.connectionHint).toBe(lib.encodeGatewayFileHint(REF));
  });

  it('ordinary hints, garbage and tampered values are not mistaken for picked files', () => {
    for (const h of [null, '', '\\\\nas\\finance', 'gateway-file:not json', 'gateway-file:{"src":1,"dir":[],"file":"a.csv"}', 'gateway-file:{"src":"x","dir":"Exports","file":"a.csv"}']) {
      expect(lib.decodeGatewayFileHint(h)).toBeNull();
    }
  });

  it('refuses a location longer than the backend limit instead of truncating it', () => {
    expect(() => lib.encodeGatewayFileHint({ ...REF, dir: Array.from({ length: 60 }, () => 'a-long-folder-name') })).toThrow(/too deep/);
  });

  it('maps the file type onto the existing source kinds, and formats details', () => {
    expect(lib.sourceKindForFile('a.CSV')).toBe('csv');
    expect(lib.sourceKindForFile('b.xlsx')).toBe('excel');
    expect(lib.sourceKindForFile('c.txt')).toBe('filesystem');
    expect(lib.formatLocation({ dir: [] })).toBe('(top folder)');
    expect(lib.formatLocation({ dir: ['Exports', '2024'] })).toBe('Exports / 2024');
    expect(lib.formatBytes(1234)).toBe('1.2 KB');
    expect(lib.formatBytes(null)).toBe('size unknown');
  });

  it('only authorized Gateway FOLDER sources are offered for browsing (never a picked file, never metadata-only)', () => {
    const base = { status: 'active', dataAccessMode: 'gateway_connected', sourceKind: 'filesystem', connectionHint: null };
    expect(lib.isGatewayFolderSource(base)).toBe(true);
    expect(lib.isGatewayFolderSource({ ...base, dataAccessMode: 'metadata_only' })).toBe(false);
    expect(lib.isGatewayFolderSource({ ...base, status: 'removed' })).toBe(false);
    expect(lib.isGatewayFolderSource({ ...base, sourceKind: 'postgresql' })).toBe(false);
    expect(lib.isGatewayFolderSource({ ...base, sourceKind: 'csv', connectionHint: lib.encodeGatewayFileHint(REF) })).toBe(false);
  });
});

describe('the picker is wired to the real Gateway and the existing APIs', () => {
  const code = (f: string): string => readFileSync(join(FRONTEND, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const picker = code('components/GatewayFilePicker.tsx');

  it('lists folders through the Gateway session and /source/browse, with no hard-coded folders or sample files', () => {
    expect(picker).toContain('openGatewaySession(');
    expect(picker).toContain('/source/browse');
    for (const fake of ['sample', 'mock', 'placeholder data', 'Documents', 'Desktop', 'C:\\\\']) {
      expect({ fake, hit: picker.includes(fake) }).toEqual({ fake, hit: false });
    }
  });

  it('adds sources only via the existing data-source API, and only on confirm', () => {
    expect(picker).toContain("'/data-sources'");
    expect(picker).toMatch(/\/data-sources\/\$\{created\.id\}\/mode/);
    const confirmBody = picker.slice(picker.indexOf('async function confirm()'));
    expect(confirmBody.indexOf("'/data-sources'")).toBeGreaterThan(-1);
    // Cancel only closes: no API call on the cancel path.
    expect(picker).toMatch(/<button type="button" onClick=\{onClose\} disabled=\{busy\}>\s*Cancel/);
  });

  /**
   * Registering a file as a data source is no longer a step every customer
   * meets: the customer page opens this same picker per connected folder (so
   * browsing needs no registration at all), and the "Select files" entry
   * point — which does register — lives on the administration page. The
   * picker component itself is unchanged, and still the only thing that
   * creates these records.
   */
  it('the picker is reachable from the customer page per folder, and from the admin page as "Select files"', () => {
    const customer = code('app/(app)/data-sources/page.tsx');
    expect(customer).toContain('<GatewayFilePicker');
    expect(customer).toContain('Choose folder'); // browse, not register
    expect(customer).not.toContain('Select files');

    const admin = code('components/SourceAdministration.tsx');
    expect(admin).toMatch(/className="primary"[^>]*onClick=\{\(\) => \{ setNotice\(null\); setPickerOpen\(true\); \}\}[^>]*>\s*Select files/);
  });
});
