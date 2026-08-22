import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CONSENT FORM BUILDER SIMPLIFICATION GUARD.
 *
 * The Consent Form Builder's "Customer Data Source" configuration (Phase
 * 3G-1's destination/mapped-column field mapping) and the "Staff-assisted
 * consent" panel built on top of it (Phase 3H-1's live customer resolve/
 * write/create) have both been REMOVED from the builder — the field editor
 * is now a plain, Google-Forms-like list (label/type/required), and a
 * field's optional additional local storage is configured via the existing
 * generic storage_mappings table (module_key 'consent_form_field').
 *
 * `frontend/src/lib/customer-resolution.ts` (the Gateway resolve/write/
 * create abstraction Phase 3H-1's panel used) is intentionally left in the
 * codebase, untouched — it may be rehomed to a dedicated screen later — but
 * it must have NO consumer in the consent form builder any more. This spec
 * statically asserts that, plus the invariants that still hold from before:
 * no customer-field-value acceptance anywhere in the public submission DTOs,
 * an exact/current route inventory, and the simplified field-type allowlist.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RESOLUTION_LIB = join(REPO_ROOT, 'frontend', 'src', 'lib', 'customer-resolution.ts');
const BUILDER_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'consent', 'forms', '[id]', 'page.tsx');
const FORMS_DTO = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'consent-forms.dto.ts');
const RECORD_DTO = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'dto.ts');
const FORMS_CONTROLLER = join(REPO_ROOT, 'backend', 'src', 'modules', 'consent', 'consent-forms.controller.ts');
const FORM_WIDGET = join(REPO_ROOT, 'sdk', 'src', 'form-widget.ts');
const SHARED_CONSENT = join(REPO_ROOT, 'shared', 'src', 'consent.ts');

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('Consent Form Builder simplification — Customer Data Source / staff-assisted consent removed', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of [RESOLUTION_LIB, BUILDER_PAGE, FORMS_DTO, RECORD_DTO, FORMS_CONTROLLER, SHARED_CONSENT]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('customer-resolution.ts still exists (left in place, may be reused later) but is no longer imported by the builder page', () => {
    const page = codeOnly(readFileSync(BUILDER_PAGE, 'utf8'));
    expect(page.includes('customer-resolution')).toBe(false);
  });

  it('the consent-forms DTO/controller no longer name the removed destination/mapped-column concepts', () => {
    const dto = codeOnly(readFileSync(FORMS_DTO, 'utf8'));
    const controller = codeOnly(readFileSync(FORMS_CONTROLLER, 'utf8'));
    for (const forbidden of ['destination', 'mappedColumn', 'newColumnName', 'newColumnType', 'CONSENT_FIELD_DESTINATIONS', 'setFormSource', 'sourceId']) {
      expect({ file: 'dto', forbidden, hit: dto.includes(forbidden) }).toEqual({ file: 'dto', forbidden, hit: false });
      expect({ file: 'controller', forbidden, hit: controller.includes(forbidden) }).toEqual({ file: 'controller', forbidden, hit: false });
    }
  });

  it('the simplified field-type allowlist is exactly text/pdf/excel', () => {
    const shared = readFileSync(SHARED_CONSENT, 'utf8');
    expect(shared).toContain(`CONSENT_FORM_FIELD_TYPES = ['text', 'pdf', 'excel']`);
  });

  it('the consent-forms controller route list is exact — no /source route, field CRUD present', () => {
    const code = codeOnly(readFileSync(FORMS_CONTROLLER, 'utf8'));
    const routes = Array.from(code.matchAll(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g)).map((m) => `${m[1]} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toEqual([
      "Get ",
      "Get ':id'",
      "Post ",
      "Put ':id'",
      "Patch ':id/active'",
      "Post ':id/customer-fields'",
      "Put ':id/customer-fields/:fieldId'",
      "Delete ':id/customer-fields/:fieldId'",
      "Post ':id/rows'",
      "Put ':id/rows/:rowId'",
      "Patch ':id/rows/:rowId/active'",
      "Delete ':id/rows/:rowId'",
      "Get ':id/submissions'",
      "Get ':id/submissions/pending-local-sync'",
      "Post ':id/submissions/:submissionId/mark-synced'",
    ]);
  });

  it('the public widget/hosted-link submission DTOs carry no hardcoded customer field — only an opaque customerId/identityValue plus answers', () => {
    const code = codeOnly(readFileSync(FORMS_DTO, 'utf8'));
    const widgetShape = /export interface WidgetSubmissionInput\s*\{\s*customerId:\s*string;\s*answers:\s*FormAnswerInput\[\];\s*\}/;
    // LinkSubmissionInput no longer hardcodes name/email/phone (Central DPDP
    // Storage correction) — identityValue is whatever the CLIENT's own field
    // marked isIdentifier collected, or null. No hardcoded field name here.
    const linkShape = /export interface LinkSubmissionInput\s*\{\s*identityValue:\s*string \| null;\s*answers:\s*FormAnswerInput\[\];\s*\}/;
    expect(widgetShape.test(code)).toBe(true);
    expect(linkShape.test(code)).toBe(true);
  });

  it('POST /consent/events (RecordConsentBody) is unchanged — no field-value acceptance was added', () => {
    const code = codeOnly(readFileSync(RECORD_DTO, 'utf8'));
    const match = code.match(/export interface RecordConsentBody\s*\{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const body = match![1]!;
    const fieldNames = Array.from(body.matchAll(/(\w+)\??:\s*/g)).map((m) => m[1]);
    expect(new Set(fieldNames)).toEqual(
      new Set(['customerId', 'purposeId', 'status', 'noticeVersionId', 'occurredAt', 'source', 'evidenceHash', 'idempotencyKey']),
    );
  });

  it('the public widget never collects a customer-data field value — its only submit body keys are customerId/answers', () => {
    const code = codeOnly(readFileSync(FORM_WIDGET, 'utf8'));
    const bodyMatch = code.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/);
    expect(bodyMatch).not.toBeNull();
    const keys = bodyMatch![1]!
      .split(',')
      .map((segment) => segment.split(':')[0]!.trim())
      .filter(Boolean);
    expect(new Set(keys)).toEqual(new Set(['customerId', 'answers']));
  });
});
