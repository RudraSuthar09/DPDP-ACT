import { BadRequestException } from '@nestjs/common';
import { parseSaveCustomerField, parseSetFormSource } from './consent-forms.dto';

/**
 * Phase 3G-1 — the customer-data field CONFIGURATION parser. Every assertion
 * here is about the mapping being EXPLICIT and never inferred: nothing derives
 * a mapping from the field's label, nothing defaults a destination, and nothing
 * here executes SQL — this is a pure request-shape validator.
 */
describe('Phase 3G-1 — parseSaveCustomerField: explicit mapping only, no auto-mapping', () => {
  // fieldType is 'text' here deliberately — these tests are about MAPPING
  // semantics (existing/new column, destination honesty), not about field-type
  // storage restrictions, which have their own describe block below.
  const base = { label: 'Aadhaar Card', fieldType: 'text', required: true };

  it('a client explicitly selecting an EXISTING column is stored as given', () => {
    const out = parseSaveCustomerField({
      ...base,
      destination: 'customer_field',
      mappedColumn: 'aadhaar_number',
      newColumnName: null,
      newColumnType: null,
    });
    expect(out.mappedColumn).toBe('aadhaar_number');
    expect(out.newColumnName).toBeNull();
  });

  it('no automatic mapping: the label "Aadhaar Card" never implies mappedColumn', () => {
    const out = parseSaveCustomerField({
      ...base,
      destination: 'customer_field',
      mappedColumn: null,
      newColumnName: null,
      newColumnType: null,
    });
    // A field can exist configured as customer_field with NO mapping chosen yet
    // — the platform never fills one in on the client's behalf.
    expect(out.mappedColumn).toBeNull();
    expect(out.newColumnName).toBeNull();
  });

  it('a consent-record field (e.g. Terms & Conditions) is recorded with NO column mapping', () => {
    const out = parseSaveCustomerField({
      label: 'Do you agree to the Terms and Conditions?',
      fieldType: 'checkbox',
      required: true,
      destination: 'consent_record',
      mappedColumn: null,
      newColumnName: null,
      newColumnType: null,
    });
    expect(out.destination).toBe('consent_record');
    expect(out.mappedColumn).toBeNull();
    expect(out.newColumnName).toBeNull();
  });

  it('rejects a consent_record field that ALSO carries a mapping (destination must be honest)', () => {
    expect(() =>
      parseSaveCustomerField({ ...base, destination: 'consent_record', mappedColumn: 'aadhaar_number', newColumnName: null, newColumnType: null }),
    ).toThrow(BadRequestException);
  });

  it('"create new column" stores ONLY the requested name/type — a configuration, not a write', () => {
    const out = parseSaveCustomerField({
      ...base,
      destination: 'customer_field',
      mappedColumn: null,
      newColumnName: 'aadhaar_number',
      newColumnType: 'text',
    });
    expect(out.newColumnName).toBe('aadhaar_number');
    expect(out.newColumnType).toBe('text');
    expect(out.mappedColumn).toBeNull();
  });

  it('rejects choosing BOTH an existing column and a new one', () => {
    expect(() =>
      parseSaveCustomerField({
        ...base,
        destination: 'customer_field',
        mappedColumn: 'aadhaar_number',
        newColumnName: 'aadhaar_number_2',
        newColumnType: 'text',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a new-column name without a declared type', () => {
    expect(() =>
      parseSaveCustomerField({ ...base, destination: 'customer_field', mappedColumn: null, newColumnName: 'aadhaar_number', newColumnType: null }),
    ).toThrow(BadRequestException);
  });

  it('rejects an unsupported new-column type (no arbitrary type string)', () => {
    expect(() =>
      parseSaveCustomerField({
        ...base,
        destination: 'customer_field',
        mappedColumn: null,
        newColumnName: 'x',
        newColumnType: 'jsonb; DROP TABLE customers;--',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a column identifier that is not a plausible identifier (no SQL-injection-shaped strings)', () => {
    // (An empty string is intentionally treated as "no mapping provided" by the
    // shared optionalStringOrNull helper, not validated as an identifier — that
    // is a no-op, not a bypass, so it is not in this list.)
    for (const evil of ['aadhaar_number; DROP TABLE customers;--', "' OR '1'='1", 'a b', '1abc']) {
      expect(() =>
        parseSaveCustomerField({ ...base, destination: 'customer_field', mappedColumn: evil, newColumnName: null, newColumnType: null }),
      ).toThrow(BadRequestException);
    }
  });

  it('requires an explicit destination — there is no default that implies a mapping', () => {
    expect(() => parseSaveCustomerField({ ...base, mappedColumn: null, newColumnName: null, newColumnType: null })).toThrow(
      BadRequestException,
    );
  });

  it('"both" (consent record + customer field) requires a real mapping decision, same rules as customer_field', () => {
    const out = parseSaveCustomerField({
      ...base,
      destination: 'both',
      mappedColumn: 'aadhaar_number',
      newColumnName: null,
      newColumnType: null,
    });
    expect(out.destination).toBe('both');
    expect(out.mappedColumn).toBe('aadhaar_number');
  });
});

describe('Phase 3 (Consent Form Builder Unification) — fieldType allowlist + document_upload/signature storage restriction', () => {
  it('accepts every type in the allowlist', () => {
    for (const fieldType of ['text', 'number', 'date', 'document_upload', 'signature', 'checkbox']) {
      const out = parseSaveCustomerField({
        label: 'A field',
        fieldType,
        required: false,
        destination: 'consent_record',
        mappedColumn: null,
        newColumnName: null,
        newColumnType: null,
      });
      expect(out.fieldType).toBe(fieldType);
    }
  });

  it('rejects a fieldType outside the allowlist', () => {
    expect(() =>
      parseSaveCustomerField({
        label: 'A field',
        fieldType: 'not_a_real_type',
        required: false,
        destination: 'consent_record',
        mappedColumn: null,
        newColumnName: null,
        newColumnType: null,
      }),
    ).toThrow(BadRequestException);
  });

  it.each(['document_upload', 'signature'])(
    '%s cannot be mapped to an existing customer column — no supported storage destination yet',
    (fieldType) => {
      expect(() =>
        parseSaveCustomerField({
          label: 'Aadhaar Document',
          fieldType,
          required: false,
          destination: 'customer_field',
          mappedColumn: 'aadhaar_document',
          newColumnName: null,
          newColumnType: null,
        }),
      ).toThrow(BadRequestException);
    },
  );

  it.each(['document_upload', 'signature'])('%s cannot be configured with destination "both" either', (fieldType) => {
    expect(() =>
      parseSaveCustomerField({
        label: 'Signature',
        fieldType,
        required: false,
        destination: 'both',
        mappedColumn: 'signature_data',
        newColumnName: null,
        newColumnType: null,
      }),
    ).toThrow(BadRequestException);
  });

  it.each(['document_upload', 'signature'])('%s IS allowed as consent-only (destination: consent_record)', (fieldType) => {
    const out = parseSaveCustomerField({
      label: 'Aadhaar Document',
      fieldType,
      required: false,
      destination: 'consent_record',
      mappedColumn: null,
      newColumnName: null,
      newColumnType: null,
    });
    expect(out.fieldType).toBe(fieldType);
    expect(out.destination).toBe('consent_record');
  });

  it('ordinary text/number/date fields are UNAFFECTED by the storage restriction', () => {
    for (const fieldType of ['text', 'number', 'date']) {
      const out = parseSaveCustomerField({
        label: 'Mobile Number',
        fieldType,
        required: false,
        destination: 'customer_field',
        mappedColumn: 'mobile',
        newColumnName: null,
        newColumnType: null,
      });
      expect(out.mappedColumn).toBe('mobile');
    }
  });
});

describe('Phase 3G-1 — parseSetFormSource: a form is associated with a source only when explicitly chosen', () => {
  it('accepts an explicit sourceId', () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    expect(parseSetFormSource({ sourceId: uuid })).toEqual({ sourceId: uuid });
  });
  it('accepts null (clearing the association) — never assumed/defaulted to a source', () => {
    expect(parseSetFormSource({ sourceId: null })).toEqual({ sourceId: null });
  });
});
