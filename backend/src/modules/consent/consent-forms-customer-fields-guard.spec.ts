import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CONSENT FORM FIELD GUARD.
 *
 * A consent form field (the simple, Google-Forms-like field list) is
 * CONFIGURATION ONLY: label/type/required. It must NEVER, from the central
 * backend:
 *   - run a schema-changing statement (ALTER TABLE / CREATE COLUMN) — a form
 *     field has never had any relationship to a client's own database schema;
 *   - write to any table other than its own (consent_form_customer_fields /
 *     consent_forms);
 *   - store a submitted customer VALUE anywhere — the browser writes that
 *     straight to Central DPDP Storage (frontend/src/lib/central-storage.ts),
 *     never through this backend;
 *   - resolve/look up a customer (no resolveCustomer, no customer lookup call);
 *   - touch Data Inventory tables/services.
 *
 * Same static-analysis style as raw-access-guard.spec / schema-source.spec: if a
 * future edit adds any of these, this test fails in the PR before the capability
 * is built around.
 */

const CONSENT_DIR = join(__dirname);
const DATASOURCE_DIR = join(__dirname, '..', 'datasource');
const INVENTORY_DIR = join(__dirname, '..', 'inventory');

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function filesIn(dir: string): string[] {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((f) => statSync(f).isFile() && f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

const PHASE_3G1_FILES = [
  join(CONSENT_DIR, 'consent-forms.dto.ts'),
  join(CONSENT_DIR, 'consent-forms.repository.ts'),
  join(CONSENT_DIR, 'consent-forms.service.ts'),
  join(CONSENT_DIR, 'consent-forms.controller.ts'),
  join(DATASOURCE_DIR, 'data-source.dto.ts'),
  join(DATASOURCE_DIR, 'data-source.repository.ts'),
  join(DATASOURCE_DIR, 'data-source.service.ts'),
  join(DATASOURCE_DIR, 'data-source.controller.ts'),
];

describe('Consent form fields — no schema write, no customer-table write, no customer resolution', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of PHASE_3G1_FILES) expect(statSync(f).isFile()).toBe(true);
  });

  it('no ALTER TABLE / CREATE COLUMN anywhere in the 3G-1 files', () => {
    for (const f of PHASE_3G1_FILES) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['ALTER TABLE', 'CREATE COLUMN', 'ADD COLUMN', 'DROP COLUMN']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('no LIVE customer lookup (the removed Gateway-side resolve/write/create flow) — the internal customer/data-principal UUID registry (DataPrincipalService.resolveCustomerId) is a different, later, deliberate capability and is NOT what this guards', () => {
    for (const f of PHASE_3G1_FILES) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['customer-resolution', 'CustomerResolutionError', 'findCustomer', 'lookupCustomer', 'customerLookup']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('the customer-field repository methods write only to their own table — no customer-table write', () => {
    const repo = codeOnly(readFileSync(join(CONSENT_DIR, 'consent-forms.repository.ts'), 'utf8'));
    // Scope to the field-CRUD section only — the rest of this file legitimately
    // writes to the PRE-EXISTING consent_form_rows/consent_form_submissions
    // tables, which this guard is not about.
    const start = repo.indexOf('listCustomerFields(');
    const end = repo.indexOf('addRow(input:');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = repo.slice(start, end);
    const writes = Array.from(section.matchAll(/\b(INSERT INTO|UPDATE)\s+([a-zA-Z_.]+)/gi)).map((m) => m[2] ?? '');
    expect(writes.length).toBeGreaterThan(0); // not vacuous — there ARE writes
    const ALLOWED_TABLES = new Set(['consent_forms', 'consent_form_customer_fields']);
    for (const table of writes) {
      expect(ALLOWED_TABLES.has(table)).toBe(true);
    }
  });

  it('consent_form_customer_fields has no column shaped like a submitted VALUE', () => {
    const migration = readFileSync(
      join(__dirname, '..', '..', '..', 'migrations', '1737003300000_consent-form-customer-fields.sql'),
      'utf8',
    );
    for (const forbidden of ['submitted_value', 'response_value', 'customer_value', 'field_value']) {
      expect(migration.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('Data Inventory files are untouched by / do not reference the 3G-1 tables', () => {
    const inventoryFiles = filesIn(INVENTORY_DIR);
    expect(inventoryFiles.length).toBeGreaterThan(5); // not vacuous
    for (const f of inventoryFiles) {
      const code = readFileSync(f, 'utf8');
      for (const forbidden of ['consent_form_customer_fields', 'identity_column', 'GatewaySourceFields', 'listFields']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it('no automatic Data-Inventory entry is created when a form field is mapped', () => {
    const service = codeOnly(readFileSync(join(CONSENT_DIR, 'consent-forms.service.ts'), 'utf8'));
    // The service's customer-field methods must not call anything inventory-shaped.
    const addField = service.slice(service.indexOf('async addCustomerField'), service.indexOf('async updateCustomerField'));
    for (const forbidden of ['inventoryEntry', 'createEntry', 'InventoryService', 'RegisterEntries']) {
      expect({ forbidden, hit: addField.includes(forbidden) }).toEqual({ forbidden, hit: false });
    }
  });
});
