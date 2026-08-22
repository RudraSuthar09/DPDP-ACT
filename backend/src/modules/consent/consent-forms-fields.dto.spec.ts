import { BadRequestException } from '@nestjs/common';
import { parseSaveCustomerField } from './consent-forms.dto';

describe('parseSaveCustomerField — the simplified, Google-Forms-like field save', () => {
  it('accepts a plain text field', () => {
    expect(parseSaveCustomerField({ label: 'Aadhaar Number', fieldType: 'text', required: true })).toEqual({
      label: 'Aadhaar Number',
      fieldType: 'text',
      required: true,
      isIdentifier: false,
    });
  });

  it('accepts isIdentifier: true — the field whose value is hashed into subject_ref', () => {
    expect(parseSaveCustomerField({ label: 'Email', fieldType: 'text', required: true, isIdentifier: true })).toEqual({
      label: 'Email',
      fieldType: 'text',
      required: true,
      isIdentifier: true,
    });
  });

  it('defaults isIdentifier to false when omitted', () => {
    expect(parseSaveCustomerField({ label: 'Aadhaar Number', fieldType: 'text' }).isIdentifier).toBe(false);
  });

  it('accepts pdf and excel field types', () => {
    expect(parseSaveCustomerField({ label: 'Identity Document', fieldType: 'pdf', required: false }).fieldType).toBe('pdf');
    expect(parseSaveCustomerField({ label: 'Financial Statement', fieldType: 'excel', required: false }).fieldType).toBe('excel');
  });

  it('rejects an unknown field type — the allowlist is fixed, never inferred', () => {
    expect(() => parseSaveCustomerField({ label: 'X', fieldType: 'signature', required: false })).toThrow(BadRequestException);
    expect(() => parseSaveCustomerField({ label: 'X', fieldType: 'number', required: false })).toThrow(BadRequestException);
  });

  it('requires a label', () => {
    expect(() => parseSaveCustomerField({ fieldType: 'text', required: false })).toThrow(BadRequestException);
  });

  it('defaults required to false when omitted', () => {
    expect(parseSaveCustomerField({ label: 'Name', fieldType: 'text' }).required).toBe(false);
  });

  it('never accepts a destination, mappedColumn, or any other legacy field — extra keys are simply ignored, not validated against', () => {
    // No destination/mappedColumn concept exists any more; passing them
    // should have no effect on the parsed result (the DTO never reads them).
    const result = parseSaveCustomerField({
      label: 'Aadhaar Number',
      fieldType: 'text',
      required: true,
      destination: 'customer_field',
      mappedColumn: 'aadhaar',
    });
    expect(result).toEqual({ label: 'Aadhaar Number', fieldType: 'text', required: true, isIdentifier: false });
  });
});
