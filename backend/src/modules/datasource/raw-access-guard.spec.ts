import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ACCESS_MODES } from '@dpdp/shared';
import { DataSourceService } from './data-source.service';
import { DataSourceRepository } from './data-source.repository';

/**
 * THE PHASE-1 ARCHITECTURAL GUARD (I1/§2.1).
 *
 * The principle this makes explicit and testable:
 *
 *     data_access_mode = 'gateway_connected'  does NOT imply  raw data is readable.
 *
 * It means only "this source is explicitly configured to permit FUTURE
 * Gateway-based raw access." Until the Gateway capability exists and is
 * authorized, raw access must FAIL CLOSED — and in Phase 1 that is guaranteed by
 * the simple fact that no raw-read capability exists anywhere in this module.
 *
 * This spec asserts that absence structurally (same static-analysis style as
 * event-sink-write-path.spec / schema-source.spec): if a future edit adds a
 * raw-read method or route, this test fails in the PR before the capability can
 * be built around.
 */

const MODULE_DIR = __dirname;

/** Names that would betray a raw-data-read capability creeping in. */
const FORBIDDEN_IDENTIFIERS = [
  'readRows',
  'getRows',
  'fetchRows',
  'sampleRows',
  'readData',
  'fetchData',
  'getValues',
  'readValues',
  'customerData',
  'rowData',
  'rawValue',
  'response_body',
  'responseBody',
  'customerRecord',
  'dumpTable',
];

/** Route path fragments that would betray a raw-data endpoint. */
const FORBIDDEN_ROUTE_FRAGMENTS = ['/rows', '/data', '/read', '/values', '/records', '/dump'];

function moduleSourceFiles(): string[] {
  return readdirSync(MODULE_DIR)
    .map((name) => join(MODULE_DIR, name))
    .filter((full) => statSync(full).isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts'));
}

/**
 * Strip line and block comments before scanning, so the guard checks the CODE,
 * not the prose. The module files deliberately NAME the forbidden identifiers in
 * their doc comments ("there is no readRows / fetchData / getValues here") — that
 * documentation must not itself trip the guard; only a real code usage should.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}


describe('Phase 1 — data sources are metadata/config only; raw access fails closed', () => {
  const files = moduleSourceFiles();

  it('the module actually has source files to check (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(4); // repo, service, dto, controller, module
  });

  it.each(FORBIDDEN_IDENTIFIERS)('no CODE in the datasource module names "%s"', (identifier) => {
    const offenders = files.filter((f) => codeOnly(readFileSync(f, 'utf8')).includes(identifier));
    if (offenders.length > 0) {
      throw new Error(
        [
          '',
          '='.repeat(74),
          `  PHASE-1 GUARD VIOLATION: "${identifier}" appears in the datasource module.`,
          ...offenders.map((f) => `    ${f}`),
          '',
          '  Data sources are METADATA/CONFIG ONLY in Phase 1. A raw-data read',
          '  capability must not exist here — Mode B is a separate future Gateway',
          '  capability. If you are building the Gateway, it does not live in this',
          '  module, and gateway_connected must still grant no raw access here.',
          '='.repeat(74),
          '',
        ].join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('the controller declares NO raw-data route', () => {
    const controller = readFileSync(join(MODULE_DIR, 'data-source.controller.ts'), 'utf8');
    // Collect the string literals in @Get/@Post/@Put/@Patch/@Delete decorators.
    const routeLiterals = Array.from(controller.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*'([^']*)'/g)).map(
      (m) => m[1] ?? '',
    );
    for (const route of routeLiterals) {
      for (const frag of FORBIDDEN_ROUTE_FRAGMENTS) {
        expect(route.includes(frag)).toBe(false);
      }
    }
  });

  it('the service exposes no method that could read source data', () => {
    // Every public method on the service, by name — none may look like a read.
    const methodNames = Object.getOwnPropertyNames(DataSourceService.prototype).filter((n) => n !== 'constructor');
    for (const name of methodNames) {
      for (const forbidden of FORBIDDEN_IDENTIFIERS) {
        expect(name.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
    // The only operations are metadata operations. recordRawAccess is a
    // metadata-only AUDIT (it takes a row count and returns { authorized }); it
    // reads no data — see its signature and the DTO (parseRawAccess), which
    // refuses any file/rows/values field.
    expect(methodNames.sort()).toEqual([
      'create',
      'get',
      'list',
      'recordGatewayEvent',
      'recordRawAccess',
      'remove',
      'setCustomerWriteConfig',
      'setIdentityColumn',
      'setMode',
      'update',
    ]);
  });

  it('the repository exposes no method that could read source data', () => {
    const methodNames = Object.getOwnPropertyNames(DataSourceRepository.prototype).filter((n) => n !== 'constructor');
    for (const name of methodNames) {
      for (const forbidden of FORBIDDEN_IDENTIFIERS) {
        expect(name.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it('gateway_connected is a real, distinct access mode — a config state, not a capability', () => {
    // It exists as a mode value (so the toggle is meaningful)...
    expect(DATA_ACCESS_MODES).toContain('gateway_connected');
    expect(DATA_ACCESS_MODES).toContain('metadata_only');
    // ...but nothing in the module reacts to it by reading data: the string
    // 'gateway_connected' must not appear next to any forbidden read identifier.
    // (Covered structurally by the FORBIDDEN_IDENTIFIERS scan above; this asserts
    // the mode itself is nothing more than a stored enum value here.)
    const service = codeOnly(readFileSync(join(MODULE_DIR, 'data-source.service.ts'), 'utf8'));
    expect(service).toContain('gateway_connected'); // it is set...
    for (const forbidden of FORBIDDEN_IDENTIFIERS) {
      expect(service).not.toContain(forbidden); // ...but never acted on as a read
    }
  });
});
