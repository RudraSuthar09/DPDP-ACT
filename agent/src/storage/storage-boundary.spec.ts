import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE STORAGE-PLANE BOUNDARY GUARD — the sibling of connectors' guards and
 * the top-level boundary.spec.ts, scoped to agent/src/storage/. It makes
 * explicit and testable that this capability is FOLDERS ONLY:
 *
 *   - no file-content read/write (createReadStream/writeFileSync/readFile
 *     content, xlsx/csv parsing) — a storage root is a filing destination for
 *     folder STRUCTURE, never a place this code reads or writes bytes into;
 *   - no outbound network call anywhere except the ONE control-plane redeem
 *     the plane itself makes through the injected client interface;
 *   - no customer-data-shaped identifier anywhere.
 */

const DIR = __dirname;

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .map((n) => join(DIR, n))
    .filter((f) => statSync(f).isFile() && f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const files = sourceFiles();
const code = Object.fromEntries(files.map((f) => [f, codeOnly(readFileSync(f, 'utf8'))] as const));

describe('Storage plane boundary — folders only, no file content, no stray network calls', () => {
  it('has runtime source to check (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5); // path-safety, provider, registry, session-store, plane
  });

  it('no file-content read/write or parsing capability exists', () => {
    const FORBIDDEN = [
      'createReadStream',
      'createWriteStream',
      'writeFileSync',
      'readFileSync',
      'readFile(',
      'appendFileSync',
      'xlsx',
      'exceljs',
      'csv-parse',
      'sheet_to_json',
      'customerData',
      'rowData',
      'fileContent',
      'fileBytes',
    ];
    for (const [file, src] of Object.entries(code)) {
      for (const forbidden of FORBIDDEN) {
        expect({ file, forbidden, hit: src.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });

  it('no outbound network call exists anywhere in this directory', () => {
    // Unlike data-plane.ts (exempted at the top-level boundary guard because
    // it is injected a ControlPlaneClient, never calls fetch itself),
    // storage-plane.ts is held to the SAME "injected, never a literal call"
    // standard — assert it literally makes no network call either.
    const OUT = ['fetch(', 'http.request', 'https.request', 'axios', 'new WebSocket', 'sendBeacon'];
    for (const [file, src] of Object.entries(code)) {
      for (const token of OUT) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('no database / central-persistence write path exists', () => {
    const DB = ["from 'pg'", 'new Pool', '.query(', 'INSERT ', 'UPDATE ', 'DELETE FROM', 'Repository', 'apply_tenant_rls'];
    for (const [file, src] of Object.entries(code)) {
      for (const token of DB) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false });
      }
    }
  });

  it('StoragePlane never dispatches to anything but browse/createFolder/verifyFolder', () => {
    const plane = code[join(DIR, 'storage-plane.ts')]!;
    // Route table pins the exact 4 paths — a future route addition must
    // extend this guard explicitly, not just start dispatching.
    expect(plane).toContain("'/storage/session/establish'");
    expect(plane).toContain("'/storage/browse'");
    expect(plane).toContain("'/storage/folder/create'");
    expect(plane).toContain("'/storage/folder/verify'");
    for (const forbidden of ['/storage/file', '/storage/read', '/storage/upload', '/storage/download', '/storage/content']) {
      expect(plane).not.toContain(forbidden);
    }
  });
});
