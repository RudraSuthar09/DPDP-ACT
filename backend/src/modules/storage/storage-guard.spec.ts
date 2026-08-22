import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StorageService } from './storage.service';
import { StorageRepository } from './storage.repository';
import { StorageGatewayService } from './storage-gateway.service';
import { StorageGatewayRepository } from './storage-gateway.repository';

/**
 * THE STORAGE ARCHITECTURAL GUARD.
 *
 * Two invariants this makes explicit and testable (see the migration header
 * and CLAUDE.md's I1):
 *
 *   1. Storage & Folder Mapping is CONFIGURATION ONLY — a root/folder/mapping
 *      is a name and a pointer, never a file, a document, or a customer
 *      value. There is no upload/download/read-content capability anywhere
 *      in this module, and there must never be one.
 *
 *   2. Every mapping is the result of an EXPLICIT client choice. There is no
 *      automatic/inferred/guessed mapping anywhere — no fuzzy matching, no
 *      "suggest a folder", no heuristic keyed off a module/entity name.
 *
 * Same static-analysis style as the datasource module's raw-access-guard.
 */

const MODULE_DIR = __dirname;

/** Names that would betray a real file-I/O or document-content capability
 *  creeping into what must stay a metadata-only control plane. */
const FORBIDDEN_CONTENT_IDENTIFIERS = [
  'readFile',
  'writeFile',
  'uploadFile',
  'downloadFile',
  'fileContent',
  'fileBytes',
  'fileBuffer',
  'documentContent',
  'rowData',
  'customerData',
  'customerRecord',
  'rawValue',
  'response_body',
  'responseBody',
];

/** Names that would betray automatic/inferred mapping — forbidden by the
 *  "no automatic guessing" requirement: every mapping must be an explicit
 *  client choice. */
const FORBIDDEN_GUESSING_IDENTIFIERS = [
  'autoMap',
  'guessFolder',
  'inferFolder',
  'suggestFolder',
  'suggestMapping',
  'detectFolder',
];

/** Route path fragments that would betray a file/document endpoint. */
const FORBIDDEN_ROUTE_FRAGMENTS = ['/upload', '/download', '/content', '/file', '/read'];

function moduleSourceFiles(): string[] {
  return readdirSync(MODULE_DIR)
    .map((name) => join(MODULE_DIR, name))
    .filter((full) => statSync(full).isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts'));
}

/** Strip comments before scanning, so the guard checks the CODE, not the
 *  prose (this file's own doc comments name the forbidden identifiers). */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('Storage & Folder Mapping — configuration only; no automatic guessing', () => {
  const files = moduleSourceFiles();

  it('the module actually has source files to check (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(4); // repo, service, dto, controller
  });

  it.each(FORBIDDEN_CONTENT_IDENTIFIERS)('no CODE in the storage module names "%s"', (identifier) => {
    const offenders = files.filter((f) => codeOnly(readFileSync(f, 'utf8')).includes(identifier));
    expect(offenders).toEqual([]);
  });

  it.each(FORBIDDEN_GUESSING_IDENTIFIERS)('no CODE in the storage module names "%s"', (identifier) => {
    const offenders = files.filter((f) => codeOnly(readFileSync(f, 'utf8')).includes(identifier));
    expect(offenders).toEqual([]);
  });

  it('the controller declares NO file/document route', () => {
    const controller = readFileSync(join(MODULE_DIR, 'storage.controller.ts'), 'utf8');
    const routeLiterals = Array.from(controller.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*'([^']*)'/g)).map((m) => m[1] ?? '');
    for (const route of routeLiterals) {
      for (const frag of FORBIDDEN_ROUTE_FRAGMENTS) {
        expect(route.includes(frag)).toBe(false);
      }
    }
  });

  it('the service exposes exactly the configuration operations, nothing else', () => {
    const methodNames = Object.getOwnPropertyNames(StorageService.prototype).filter((n) => n !== 'constructor');
    expect(methodNames.sort()).toEqual([
      'createFolder',
      'createRoot',
      'deactivateMapping',
      'getMapping',
      'getRoot',
      'listFolders',
      'listMappings',
      'listRoots',
      'removeFolder',
      'removeRoot',
      'setMapping',
      'updateRoot',
    ]);
  });

  it('the repository exposes exactly the configuration operations, nothing else', () => {
    const methodNames = Object.getOwnPropertyNames(StorageRepository.prototype).filter((n) => n !== 'constructor');
    expect(methodNames.sort()).toEqual([
      'createFolder',
      'createRoot',
      'deactivateMapping',
      'findFolder',
      'findMapping',
      'findRoot',
      'hasActiveChildren',
      'hasActiveFoldersForRoot',
      'hasActiveMappings',
      'listAllFoldersForRoot',
      'listMappings',
      'listRoots',
      'tombstoneFolder',
      'tombstoneRoot',
      'updateRoot',
      'upsertMapping',
    ]);
  });

  it('the storage-gateway control plane exposes exactly pairing + redeem, nothing else', () => {
    const methodNames = Object.getOwnPropertyNames(StorageGatewayService.prototype).filter((n) => n !== 'constructor');
    expect(methodNames.sort()).toEqual(['createPairing', 'redeemPairing']);
  });

  it('the storage-gateway repository moves ids/hashes/metadata only, nothing else', () => {
    const methodNames = Object.getOwnPropertyNames(StorageGatewayRepository.prototype).filter((n) => n !== 'constructor');
    expect(methodNames.sort()).toEqual(['consumePairing', 'createPairing', 'createSession', 'findPairingByHash', 'findSessionByHash']);
  });

  it('the storage-gateway tables store hashes only — never a raw nonce/token column', () => {
    const migration = readFileSync(
      join(MODULE_DIR, '..', '..', '..', 'migrations', '1737004200000_gateway-storage-plane.sql'),
      'utf8',
    );
    expect(migration).toContain('nonce_hash');
    expect(migration).toContain('token_hash');
    expect(migration).not.toMatch(/\braw_nonce\b/);
    expect(migration).not.toMatch(/\braw_token\b/);
  });

  it('storage_mappings has no foreign key into another module\'s table (polymorphic by design, R2)', () => {
    const migration = readFileSync(
      join(MODULE_DIR, '..', '..', '..', 'migrations', '1737004100000_storage-configuration.sql'),
      'utf8',
    );
    // entity_id is a bare uuid column — never `REFERENCES consent_forms` or any
    // other module's table. This is what makes the module reusable by future
    // modules without a schema change (see the migration header).
    expect(migration).not.toMatch(/entity_id\s+uuid[^,]*REFERENCES/i);
  });
});
