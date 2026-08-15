import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from 'xlsx';
import { PathSecurityError, resolveWithinRoots } from './path-safety';
import { ConnectorError, FilesystemConnector } from './filesystem-connector';
import { ConnectorRegistry } from './registry';

const SENTINEL = 'AADHAAR_999988887777';
const CSV = ['Name,Aadhaar,Email', `Asha,${SENTINEL},asha@example.com`, 'Ravi,111122223333,ravi@example.com'].join('\n');

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dpdp-conn-root-'));
  outside = mkdtempSync(join(tmpdir(), 'dpdp-conn-out-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'customers.csv'), CSV, 'utf8');
  writeFileSync(join(root, 'notes.txt'), 'not a spreadsheet', 'utf8'); // forbidden type
  writeFileSync(join(outside, 'secret.csv'), 'a,b\n1,2', 'utf8'); // outside the root

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'PAN'], ['Asha', 'ABCDE1234F'], ['Ravi', 'PQRSX6789Z']]), 'S1');
  writeFileSync(join(root, 'sub', 'data.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('Phase 3D — path containment', () => {
  it('accepts an approved file inside a root', () => {
    expect(resolveWithinRoots(join(root, 'customers.csv'), [root])).toContain('customers.csv');
  });
  it('forbidden path (outside roots) fails closed', () => {
    expect(() => resolveWithinRoots(join(outside, 'secret.csv'), [root])).toThrow(PathSecurityError);
    try {
      resolveWithinRoots(join(outside, 'secret.csv'), [root]);
    } catch (e) {
      expect((e as PathSecurityError).code).toBe('PATH_NOT_ALLOWED');
    }
  });
  it('path traversal (..) fails closed', () => {
    expect(() => resolveWithinRoots(join(root, '..', '..', 'etc', 'passwd'), [root])).toThrow(PathSecurityError);
  });
  it('an unapproved extension inside a root is rejected', () => {
    try {
      resolveWithinRoots(join(root, 'notes.txt'), [root]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PathSecurityError).code).toBe('UNSUPPORTED_SOURCE');
    }
  });
  it('a symlink escaping the root is rejected (or skipped where symlinks are unavailable)', () => {
    const link = join(root, 'escape.csv');
    try {
      symlinkSync(join(outside, 'secret.csv'), link);
    } catch {
      return; // no symlink privilege (e.g. Windows without dev mode) — skip
    }
    try {
      resolveWithinRoots(link, [root]);
      throw new Error('symlink escape was not blocked');
    } catch (e) {
      expect((e as PathSecurityError).code).toBe('PATH_NOT_ALLOWED');
    }
  });
});

describe('Phase 3D — FilesystemConnector (CSV + XLSX + folder)', () => {
  const connector = () => new FilesystemConnector('filesystem', [root]);

  it('discovers only approved files (csv + xlsx, not .txt, not hidden)', async () => {
    const res = await connector().discover();
    const labels = res.handles.map((h) => h.descriptor.label).sort();
    expect(labels).toEqual(['customers.csv', 'data.xlsx']);
    expect(res.handles.every((h) => h.descriptor.resourceKind === 'file')).toBe(true);
    // handles are opaque (not the filename/path)
    expect(res.handles.every((h) => !h.handle.includes('customers') && !h.handle.includes('/'))).toBe(true);
  });

  it('CSV works: read returns headers + raw rows', async () => {
    const c = connector();
    const { handles } = await c.discover();
    const csv = handles.find((h) => h.descriptor.label === 'customers.csv')!;
    const rows = await c.read(csv.handle);
    expect(rows.headers).toEqual(['Name', 'Aadhaar', 'Email']);
    expect(rows.rows.flat()).toContain(SENTINEL);
  });

  it('XLSX works: read returns headers + rows', async () => {
    const c = connector();
    const { handles } = await c.discover();
    const xlsx = handles.find((h) => h.descriptor.label === 'data.xlsx')!;
    const rows = await c.read(xlsx.handle);
    expect(rows.headers).toEqual(['Name', 'PAN']);
    expect(rows.rows.length).toBe(2);
  });

  it('read is bounded (limit + cursor)', async () => {
    const c = connector();
    const { handles } = await c.discover();
    const csv = handles.find((h) => h.descriptor.label === 'customers.csv')!;
    const page = await c.read(csv.handle, { limit: 1 });
    expect(page.rows.length).toBe(1);
    expect(page.nextCursor).toBe('1');
    expect(page.truncated).toBe(true);
  });

  it('search filters by label', async () => {
    const res = await connector().search('customers');
    expect(res.handles.map((h) => h.descriptor.label)).toEqual(['customers.csv']);
  });

  it('metadata returns size + kind, no content', async () => {
    const c = connector();
    const { handles } = await c.discover();
    const meta = await c.metadata(handles[0]!.handle);
    expect(meta.resourceKind).toBe('file');
    expect(meta.sizeBytes).toBeGreaterThan(0);
  });

  it('an invalid handle fails closed', async () => {
    await expect(connector().read('not-a-real-handle')).rejects.toBeInstanceOf(ConnectorError);
    try {
      await connector().read('not-a-real-handle');
    } catch (e) {
      expect((e as ConnectorError).code).toBe('FILE_NOT_FOUND');
    }
  });

  describe('Phase 3G-1 — listFields (header-only field discovery, no data rows)', () => {
    it('CSV: returns the header row as field names, and NO data row/value', async () => {
      const c = connector();
      const { handles } = await c.discover();
      const csv = handles.find((h) => h.descriptor.label === 'customers.csv')!;
      const res = await c.listFields(csv.handle);
      expect(res.fields.map((f) => f.name)).toEqual(['Name', 'Aadhaar', 'Email']);
      expect(res.fields.every((f) => f.type === 'text' && f.nullable === true)).toBe(true);
      // the sentinel customer VALUE must never appear in field discovery output
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
    });

    it('XLSX: returns the header row only', async () => {
      const c = connector();
      const { handles } = await c.discover();
      const xlsx = handles.find((h) => h.descriptor.label === 'data.xlsx')!;
      const res = await c.listFields(xlsx.handle);
      expect(res.fields.map((f) => f.name)).toEqual(['Name', 'PAN']);
      expect(JSON.stringify(res)).not.toContain('ABCDE1234F'); // no PAN value leaked
    });

    it('an invalid handle fails closed', async () => {
      await expect(connector().listFields('bogus-handle')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });
  });

  it('healthCheck passes for a reachable root', async () => {
    expect(await connector().healthCheck()).toMatchObject({ status: 'ok' });
  });
});

describe('Phase 3D — ConnectorRegistry', () => {
  it('an unconfigured source has no connector (fail closed)', () => {
    const reg = new ConnectorRegistry([{ sourceId: 's1', kind: 'csv', roots: [root] }]);
    expect(() => reg.get('unknown')).toThrow(ConnectorError);
  });
  it('a file source resolves to a FilesystemConnector, cached per source', () => {
    const reg = new ConnectorRegistry([{ sourceId: 's1', kind: 'excel', roots: [root] }]);
    expect(reg.get('s1')).toBe(reg.get('s1'));
  });
  it('a database source without a connection config fails closed', () => {
    // DB connectors exist since Phase 3E, but a source with no connection settings
    // must never resolve to a usable connector.
    const reg = new ConnectorRegistry([{ sourceId: 'db', kind: 'postgresql' }]);
    try {
      reg.get('db');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConnectorError).code).toBe('SOURCE_NOT_AUTHORIZED');
    }
  });
});
