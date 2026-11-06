import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE STORAGE-PLANE BOUNDARY GUARD — the sibling of connectors' guards and
 * the top-level boundary.spec.ts, scoped to agent/src/storage/. It makes
 * explicit and testable that this capability is FOLDERS, PLUS EXACTLY ONE
 * NARROW, DOCUMENTED FILE-WRITE EXCEPTION:
 *
 *   - gateway-storage-provider.ts's writeFile (and ONLY that function, in
 *     ONLY that file) may write file bytes, for Enterprise consent-form
 *     field delivery (shared/src/gateway.ts's StorageConnector.writeFile
 *     doc). It writes ONLY caller-supplied bytes it is given — it never
 *     READS file content, never parses a file, and never returns content —
 *     so the "no read, no parse, no customer value" invariants below still
 *     hold for it;
 *   - no OTHER file touches file-content read/write (createReadStream/
 *     writeFileSync/readFile content, xlsx/csv parsing) — every other file
 *     in this directory still only ever reads/writes folder STRUCTURE;
 *   - no outbound network call anywhere except the ONE control-plane redeem
 *     the plane itself makes through the injected client interface;
 *   - no customer-data-shaped identifier anywhere, including in the write
 *     path (it never reads a value back, so there is nothing to carry one).
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

  const WRITE_FILE_NAME = join(DIR, 'gateway-storage-provider.ts');

  it('no file CONTENT read, or parsing capability, exists anywhere (the write exception below never reads)', () => {
    const FORBIDDEN_EVERYWHERE = [
      'createReadStream',
      'readFileSync',
      'readFile(',
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
      for (const forbidden of FORBIDDEN_EVERYWHERE) {
        expect({ file, forbidden, hit: src.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });

  it('no file-content WRITE capability exists outside the one, narrow, documented exception', () => {
    const FORBIDDEN_WRITE_APIS = ['createWriteStream', 'writeFileSync', 'appendFileSync'];
    for (const [file, src] of Object.entries(code)) {
      if (file === WRITE_FILE_NAME) continue; // the exception itself — asserted separately below
      for (const forbidden of FORBIDDEN_WRITE_APIS) {
        expect({ file, forbidden, hit: src.includes(forbidden) }).toEqual({ file, forbidden, hit: false });
      }
    }
  });

  it('the one write exception (gateway-storage-provider.ts) is exactly what it claims: one function, low-level atomic primitives only, every safety check present', () => {
    const src = code[WRITE_FILE_NAME]!;
    // Still none of the HIGH-LEVEL write APIs — it uses the low-level fd
    // primitives (openSync/writeSync/renameSync) so the temp-then-rename
    // atomicity is explicit in this file, not hidden inside fs.writeFile.
    for (const forbidden of ['createWriteStream', 'writeFileSync', 'appendFileSync']) {
      expect(src.includes(forbidden)).toBe(false);
    }
    // And every safety check this spec's header promises is actually present.
    for (const required of ['resolveWriteDir', 'assertSafeFilename', 'MAX_WRITE_BYTES', 'existsSync(target)', "'wx'", 'fsyncSync', 'renameSync']) {
      expect({ required, hit: src.includes(required) }).toEqual({ required, hit: true });
    }
    // Exactly one write-capable method is exported from this file.
    expect((src.match(/async writeFile\(/g) ?? []).length).toBe(1);
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

  it('StoragePlane never dispatches to anything but browse/createFolder/verifyFolder/write', () => {
    const plane = code[join(DIR, 'storage-plane.ts')]!;
    // Route table pins the exact 5 paths — a future route addition must
    // extend this guard explicitly, not just start dispatching.
    expect(plane).toContain("'/storage/session/establish'");
    expect(plane).toContain("'/storage/browse'");
    expect(plane).toContain("'/storage/folder/create'");
    expect(plane).toContain("'/storage/folder/verify'");
    expect(plane).toContain("'/storage/write'");
    for (const forbidden of ['/storage/file', '/storage/read', '/storage/upload', '/storage/download', '/storage/content']) {
      expect(plane).not.toContain(forbidden);
    }
  });

  it('writeFile is authorized by the SAME session check as browse/createFolder/verifyFolder — no separate, weaker check', () => {
    const plane = code[join(DIR, 'storage-plane.ts')]!;
    const method = plane.slice(plane.indexOf('async writeFile('), plane.indexOf('\n}', plane.indexOf('async writeFile(')));
    expect(method).toContain('this.providerFor(sessionToken, storageRootId)');
  });
});
