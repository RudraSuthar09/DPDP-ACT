import { BadRequestException } from '@nestjs/common';
import { parseLinkSubmission } from './consent-forms.dto';

const FIELD_ID = '11111111-1111-1111-1111-111111111111';

function base64Of(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString('base64');
}

/**
 * parseLinkSubmission's `fieldValues` — the Central DPDP Storage automatic
 * sync (Enterprise half). Sent by the hosted-link frontend ONLY when the
 * tenant has an active 'server' storage root (publicFormForLink's
 * hasServerStorage); absent for every other tenant, in which case this
 * parses to an empty array and nothing about the existing (I1-preserving)
 * submission shape changes.
 */
describe('parseLinkSubmission — fieldValues (Enterprise synchronous write)', () => {
  const base = { identityValue: null, answers: [{ consentPurposeId: '22222222-2222-2222-2222-222222222222', granted: true }] };

  it('defaults to an empty array when fieldValues is absent — unchanged for every SaaS-only tenant', () => {
    expect(parseLinkSubmission(base).fieldValues).toEqual([]);
  });

  it('accepts a text field value', () => {
    const result = parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID, textValue: 'hello@example.com' }] });
    expect(result.fieldValues).toEqual([{ fieldId: FIELD_ID, textValue: 'hello@example.com' }]);
  });

  it('accepts a file field value (base64)', () => {
    const contentBase64 = base64Of(1024);
    const result = parseLinkSubmission({
      ...base,
      fieldValues: [{ fieldId: FIELD_ID, file: { filename: 'aadhaar.pdf', contentBase64 } }],
    });
    expect(result.fieldValues).toEqual([{ fieldId: FIELD_ID, file: { filename: 'aadhaar.pdf', contentBase64 } }]);
  });

  it('rejects an entry with neither textValue nor file', () => {
    expect(() => parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID }] })).toThrow(BadRequestException);
  });

  it('rejects an entry with BOTH textValue and file', () => {
    expect(() =>
      parseLinkSubmission({
        ...base,
        fieldValues: [{ fieldId: FIELD_ID, textValue: 'x', file: { filename: 'a.pdf', contentBase64: base64Of(4) } }],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-UUID fieldId', () => {
    expect(() => parseLinkSubmission({ ...base, fieldValues: [{ fieldId: 'not-a-uuid', textValue: 'x' }] })).toThrow(
      BadRequestException,
    );
  });

  it('rejects two entries for the same fieldId', () => {
    expect(() =>
      parseLinkSubmission({
        ...base,
        fieldValues: [
          { fieldId: FIELD_ID, textValue: 'first' },
          { fieldId: FIELD_ID, textValue: 'second' },
        ],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid base64', () => {
    expect(() =>
      parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID, file: { filename: 'a.pdf', contentBase64: 'not base64!!' } }] }),
    ).toThrow(BadRequestException);
  });

  it('rejects a file over the 8MB decoded cap — a compliance document, not an arbitrary upload target', () => {
    const contentBase64 = base64Of(9 * 1024 * 1024); // 9MB decoded
    expect(() =>
      parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID, file: { filename: 'huge.pdf', contentBase64 } }] }),
    ).toThrow(BadRequestException);
  });

  it('accepts a file right at the boundary and rejects one byte over', () => {
    const atLimit = base64Of(8 * 1024 * 1024);
    expect(() =>
      parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID, file: { filename: 'ok.pdf', contentBase64: atLimit } }] }),
    ).not.toThrow();
  });

  it('rejects text over the 10,000 character cap', () => {
    expect(() =>
      parseLinkSubmission({ ...base, fieldValues: [{ fieldId: FIELD_ID, textValue: 'x'.repeat(10_001) }] }),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-array fieldValues', () => {
    expect(() => parseLinkSubmission({ ...base, fieldValues: 'nope' })).toThrow(BadRequestException);
  });
});
