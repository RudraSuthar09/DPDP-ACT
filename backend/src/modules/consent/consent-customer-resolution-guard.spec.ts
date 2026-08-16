import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PHASE-3H-1 CUSTOMER-RESOLUTION BOUNDARY GUARD.
 *
 * Phase 3H-1 lets the staff-assisted Consent flow resolve/update a customer in
 * a client's connected source (Enterprise Gateway or SaaS local Excel/CSV)
 * ENTIRELY from the browser. This spec statically asserts the invariants that
 * make that safe, in the same style as frontend-raw-data-boundary.spec.ts and
 * local-source-handles-guard.spec.ts:
 *
 *   - the identity value, any field value, and any customer reference NEVER
 *     appear in a call to our own backend (apiFetch) — the only backend calls
 *     customer-resolution.ts makes are the pre-existing, metadata-only Gateway
 *     control-plane routes (GET /gateway/devices/active, POST /gateway/pairings);
 *   - there is no SQL anywhere in this module — every operation is a
 *     structured JSON call, never a query string;
 *   - the SaaS local-file path never calls apiFetch at all (it is pure
 *     browser-local IndexedDB + file parsing);
 *   - writeCustomerFields/createCustomer for a local file are unconditionally
 *     unsupported — there is no code path that could write to it;
 *   - the public widget/hosted-link submission DTOs are UNCHANGED by this
 *     phase — no customer-field-value acceptance was added to them;
 *   - the existing POST /consent/events DTO is UNCHANGED — no field-value
 *     acceptance was added there either (the staff-assisted flow reuses it
 *     exactly as it already was);
 *   - a column-match suggestion is never auto-applied.
 *
 * (This runs in the backend jest suite because that is the project's test
 * runner; it only reads the frontend source files, it does not import them.)
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RESOLUTION_LIB = join(REPO_ROOT, 'frontend', 'src', 'lib', 'customer-resolution.ts');
const BUILDER_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx');
const WIDGET_DTO = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'consent-forms.dto.ts');
const RECORD_DTO = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'dto.ts');
const MIGRATION = join(REPO_ROOT, 'backend', 'migrations', '1737003500000_data-source-customer-write-config.sql');
const NOTICE_MIGRATION = join(REPO_ROOT, 'backend', 'migrations', '1737003600000_consent-form-notice-text.sql');
const FORMS_CONTROLLER = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'consent-forms.controller.ts');
const FORM_WIDGET = join(REPO_ROOT, 'sdk', 'src', 'form-widget.ts');
const FORM_PORTAL_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', 'forms', '[slug]', 'page.tsx');

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function sqlCodeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

describe('Phase 3H-1 — customer resolution stays browser-side; no customer value ever reaches the backend', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of [RESOLUTION_LIB, BUILDER_PAGE, WIDGET_DTO, RECORD_DTO, MIGRATION]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('customer-resolution.ts: every apiFetch call is one of the two pre-existing, metadata-only Gateway control-plane routes', () => {
    const code = codeOnly(readFileSync(RESOLUTION_LIB, 'utf8'));
    const calls = Array.from(code.matchAll(/apiFetch(?:<[^>]*>)?\(\s*(['"`])([^'"`]*)\1/g)).map((m) => m[2] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const ok = call === '/gateway/devices/active' || call === '/gateway/pairings';
      expect({ call, ok }).toEqual({ call, ok: true });
    }
  });

  it('customer-resolution.ts: the identity value, field values, and customerRef are never named as apiFetch body keys', () => {
    const code = codeOnly(readFileSync(RESOLUTION_LIB, 'utf8'));
    for (const bad of ['identityValue', 'customerRef', 'fields:', "'fields'"]) {
      // These identifiers legitimately exist as function parameters/variables in
      // this file (it IS the module that carries them to the Gateway/local file);
      // what must never exist is passing them into an apiFetch(...) call body.
      const apiFetchCalls = Array.from(code.matchAll(/apiFetch\([^)]*\)/gs)).map((m) => m[0]);
      for (const call of apiFetchCalls) {
        expect(call.includes(bad)).toBe(false);
      }
    }
  });

  it('customer-resolution.ts contains no SQL — every operation is a structured JSON call', () => {
    // Strip `import ... from '...'` lines first — "from " is a normal part of
    // ES module syntax, not evidence of SQL.
    const withoutImports = codeOnly(readFileSync(RESOLUTION_LIB, 'utf8'))
      .split('\n')
      .filter((line) => !/^\s*import\b/.test(line) && !/from\s+['"]/.test(line))
      .join('\n');
    for (const sqlKeyword of ['SELECT ', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'ALTER TABLE', 'DROP TABLE', ' FROM ']) {
      expect(withoutImports.toUpperCase().includes(sqlKeyword)).toBe(false);
    }
  });

  it('the SaaS local-file resolve path never calls the backend at all', () => {
    const code = codeOnly(readFileSync(RESOLUTION_LIB, 'utf8'));
    const start = code.indexOf('async function resolveCustomerLocal');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('\n}', start);
    const body = code.slice(start, end);
    expect(body.includes('apiFetch')).toBe(false);
    expect(body.includes('fetch(')).toBe(false);
  });

  it('local Excel/CSV write/create are unconditionally UNSUPPORTED_SOURCE — no write path exists', () => {
    const code = codeOnly(readFileSync(RESOLUTION_LIB, 'utf8'));
    // writeCustomerFields()/createCustomer() must refuse local-file kinds BEFORE
    // any Gateway dispatch — i.e. the local branch throws, it never calls a
    // *Local write function (none exists).
    expect(code).not.toMatch(/function writeCustomerFieldsLocal/);
    expect(code).not.toMatch(/function createCustomerLocal/);
    expect(code).toContain("'UNSUPPORTED_SOURCE'");
    expect(code).toContain('Customer data updates are not supported for local Excel/CSV sources yet');
  });

  it('a column-match suggestion is shown but never auto-applied in the builder', () => {
    const code = codeOnly(readFileSync(BUILDER_PAGE, 'utf8'));
    expect(code).toContain('suggestColumnMatch');
    // The suggestion must only ever be applied inside an onClick handler — never
    // as a direct setCfMappedColumn(suggestion) outside a button's onClick.
    const directApply = /setCfMappedColumn\(suggestion\)/g;
    const matches = Array.from(code.matchAll(directApply));
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const before = code.slice(Math.max(0, m.index! - 60), m.index!);
      expect(before).toContain('onClick');
    }
  });

  it('the public widget/hosted-link submission DTOs are unchanged — no customer-field-value acceptance was added', () => {
    const code = codeOnly(readFileSync(WIDGET_DTO, 'utf8'));
    const widgetShape = /export interface WidgetSubmissionInput\s*\{\s*customerId:\s*string;\s*answers:\s*FormAnswerInput\[\];\s*\}/;
    const linkShape =
      /export interface LinkSubmissionInput\s*\{\s*name:\s*string;\s*email:\s*string \| null;\s*phone:\s*string \| null;\s*answers:\s*FormAnswerInput\[\];\s*\}/;
    expect(widgetShape.test(code)).toBe(true);
    expect(linkShape.test(code)).toBe(true);
  });

  it('POST /consent/events (RecordConsentBody) is unchanged — no field-value acceptance was added', () => {
    const code = codeOnly(readFileSync(RECORD_DTO, 'utf8'));
    // Extract the interface body and check its field NAMES only — robust to
    // comment/formatting/line-ending changes, strict about the field set.
    const match = code.match(/export interface RecordConsentBody\s*\{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const body = match![1]!;
    const fieldNames = Array.from(body.matchAll(/(\w+)\??:\s*/g)).map((m) => m[1]);
    expect(new Set(fieldNames)).toEqual(
      new Set(['customerId', 'purposeId', 'status', 'noticeVersionId', 'occurredAt', 'source', 'evidenceHash', 'idempotencyKey']),
    );
  });

  it('the migration adds only two plain config columns — no customer table, no value column', () => {
    const sql = sqlCodeOnly(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toContain('ADD COLUMN allow_customer_create boolean');
    expect(sql).toContain('ADD COLUMN writable_columns text[]');
    for (const forbidden of ['CREATE TABLE', 'customer_value', 'field_value', 'row_value']) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('writable_columns defaults empty and allow_customer_create defaults false (fail closed)', () => {
    const sql = sqlCodeOnly(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toContain("DEFAULT false");
    expect(sql).toMatch(/DEFAULT '\{\}'/);
  });
});

describe('Phase 3 (Consent Form Builder Unification) — notice text stays plain, document/signature never map to a customer column', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of [NOTICE_MIGRATION, FORMS_CONTROLLER, FORM_WIDGET, FORM_PORTAL_PAGE]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('the notice-text migration adds one plain nullable column — no table, no new route implied', () => {
    const sql = sqlCodeOnly(readFileSync(NOTICE_MIGRATION, 'utf8'));
    expect(sql).toContain('ADD COLUMN notice_text text');
    expect(sql).not.toContain('NOT NULL');
    expect(sql).not.toContain('CREATE TABLE');
  });

  it('no new consent-forms route was added — notice text rides the existing PUT /consent/forms/:id', () => {
    const code = codeOnly(readFileSync(FORMS_CONTROLLER, 'utf8'));
    const routes = Array.from(code.matchAll(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g)).map((m) => `${m[1]} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toEqual([
      "Get ",
      "Get ':id'",
      "Post ",
      "Put ':id'",
      "Patch ':id/active'",
      "Patch ':id/source'",
      "Post ':id/customer-fields'",
      "Put ':id/customer-fields/:fieldId'",
      "Delete ':id/customer-fields/:fieldId'",
      "Post ':id/rows'",
      "Put ':id/rows/:rowId'",
      "Patch ':id/rows/:rowId/active'",
      "Delete ':id/rows/:rowId'",
      "Get ':id/submissions'",
    ]);
  });

  it('the public widget never collects a customer-data field value — its only submit body keys are customerId/answers', () => {
    const code = codeOnly(readFileSync(FORM_WIDGET, 'utf8'));
    const bodyMatch = code.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/);
    expect(bodyMatch).not.toBeNull();
    // Each comma-separated segment is either `key: value` or a shorthand `key`.
    const keys = bodyMatch![1]!
      .split(',')
      .map((segment) => segment.split(':')[0]!.trim())
      .filter(Boolean);
    expect(new Set(keys)).toEqual(new Set(['customerId', 'answers']));
  });

  it('the widget/hosted-link notice rendering is read-only text — no input, no file, no upload element added for it', () => {
    for (const f of [FORM_WIDGET, FORM_PORTAL_PAGE]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      expect(code).toContain('noticeText');
      expect(code.includes("createElement('input')")).toBe(f === FORM_WIDGET ? true : false); // widget still only creates checkbox inputs for rows
    }
  });

  it('document_upload/signature can never be saved with a customer-column destination (defence in depth, mirrors the DTO test)', () => {
    const dto = codeOnly(readFileSync(WIDGET_DTO, 'utf8'));
    expect(dto).toContain('CONSENT_FIELD_TYPES_WITHOUT_STORAGE');
    expect(dto).toMatch(/has no supported customer-record storage destination yet/);
  });

  it('the builder never claims a document/signature value was stored — it shows the limitation explicitly', () => {
    const code = codeOnly(readFileSync(BUILDER_PAGE, 'utf8')).replace(/\s+/g, ' ');
    expect(code).toMatch(/stored anywhere yet|no supported storage destination/i);
    expect(code).toContain('NO_STORAGE_TYPES');
  });
});
