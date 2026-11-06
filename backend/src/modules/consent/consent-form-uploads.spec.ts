import { BadRequestException } from '@nestjs/common';
import { DEFAULT_UPLOAD_MAX_BYTES, UPLOAD_MAX_BYTES_CEILING, inspectUpload } from '@dpdp/shared';
import { acceptUpload, isTypeCheckedUpload, uploadRulesFor } from './consent-form-uploads';
import { parseSaveCustomerField } from './consent-forms.dto';
import { enterpriseCopyFilename } from '../delivery/submission-delivery.service';

/**
 * File-upload fields: what a form owner may configure, and what a respondent
 * may actually get past the server.
 *
 * The premise of every test below is that the filename and the Content-Type
 * are the RESPONDENT's input, so neither decides anything. Only the bytes do.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n trailer', 'utf8');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('heic')]);
/** A Windows executable. The thing that must never be accepted, whatever it
 *  is called and whatever type it claims. */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x41)]);
/** A zip — and therefore also a .xlsx, a .docx and a .jar. Deliberately not
 *  in the allowlist: a container that can carry executable content. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
/** SVG is XML, and XML can carry script. Not an image for this purpose. */
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
/** A WAV: a RIFF container that is NOT a WEBP. Catches a signature check that
 *  looks only at the first four bytes. */
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]);

const fileField = (over: Partial<{ allowed_file_kinds: string; max_file_bytes: number }> = {}) => ({
  id: 'field-1',
  label: 'Passport photo',
  field_type: 'file',
  allowed_file_kinds: 'image_pdf',
  max_file_bytes: DEFAULT_UPLOAD_MAX_BYTES,
  ...over,
});

const accept = (bytes: Buffer, over: Parameters<typeof fileField>[0] = {}) =>
  acceptUpload(uploadRulesFor(fileField(over)), bytes.toString('base64'));

describe('what the bytes say, not what the request claims', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg', '.jpg'],
    ['PNG', PNG, 'image/png', '.png'],
    ['WEBP', WEBP, 'image/webp', '.webp'],
    ['HEIC', HEIC, 'image/heic', '.heic'],
    ['PDF', PDF, 'application/pdf', '.pdf'],
  ])('accepts a real %s and names it from its proved type', (_n, bytes, contentType, extension) => {
    expect(accept(bytes)).toMatchObject({ contentType, extension, byteSize: bytes.length });
  });

  it.each([
    ['a Windows executable', EXE],
    ['a zip (so also .xlsx/.docx/.jar)', ZIP],
    ['an SVG, which is scriptable XML', SVG],
    ['a WAV wearing a RIFF header like WEBP does', WAV],
    ['plain text', Buffer.from('just text', 'utf8')],
  ])('refuses %s', (_n, bytes) => {
    expect(() => accept(bytes)).toThrow(BadRequestException);
    expect(() => accept(bytes)).toThrow(/not a file type this form accepts/);
  });

  it('refuses an executable however it is labelled — the filename is never consulted', () => {
    // The caller supplies no filename to acceptUpload at all. That is the
    // point: there is no parameter through which a name could influence the
    // verdict or the stored extension.
    expect(() => accept(EXE)).toThrow(BadRequestException);
    expect(acceptUpload.length).toBe(2);
  });

  it('refuses a file larger than THIS field allows, and says the limit', () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]);
    expect(() => accept(big, { max_file_bytes: 2 * 1024 * 1024 })).toThrow(/too large/i);
    // ...and accepts the same file where the cap allows it.
    expect(accept(big, { max_file_bytes: 5 * 1024 * 1024 }).byteSize).toBe(big.length);
  });

  it('refuses an empty upload, and a body that is not really base64', () => {
    expect(() => accept(Buffer.alloc(0))).toThrow(/empty/i);
    expect(() => acceptUpload(uploadRulesFor(fileField()), '!!!!')).toThrow(/empty|not a file type/i);
  });

  it('honours the field\'s configured kinds: a PDF-only field refuses a photo, and the reverse', () => {
    expect(() => accept(JPEG, { allowed_file_kinds: 'pdf' })).toThrow(/not a file type/);
    expect(accept(PDF, { allowed_file_kinds: 'pdf' }).contentType).toBe('application/pdf');
    expect(() => accept(PDF, { allowed_file_kinds: 'image' })).toThrow(/not a file type/);
    expect(accept(JPEG, { allowed_file_kinds: 'image' }).contentType).toBe('image/jpeg');
  });

  it('a refusal says nothing about the tenant, the storage, or which types exist', () => {
    let message = '';
    try {
      accept(EXE);
    } catch (err) {
      message = (err as BadRequestException).message;
    }
    expect(message).toContain('Passport photo');
    expect(message).not.toMatch(/image\/|application\/|jpg|png|pdf|gateway|tenant|folder/i);
  });

  it('the shared inspector is the same one the browser runs — pure, and byte-driven', () => {
    expect(inspectUpload(EXE, { kind: 'image_pdf', maxBytes: 1024 })).toMatchObject({
      ok: false,
      reason: 'TYPE_UNRECOGNISED',
      contentType: null,
    });
    expect(inspectUpload(PDF, { kind: 'image', maxBytes: 1024 })).toMatchObject({
      ok: false,
      reason: 'TYPE_NOT_ALLOWED',
      // It DID identify the file; it simply is not allowed here.
      contentType: 'application/pdf',
    });
  });
});

describe('the stored filename', () => {
  it('uses the PROVED extension, never the one the respondent sent', () => {
    const name = enterpriseCopyFilename({
      submissionId: 'sub-1',
      fieldId: 'fld-1',
      label: 'Passport photo',
      originalFilename: 'invoice.exe',
      extension: '.jpg',
    });
    expect(name).toBe('Passport photo - sub-1 - fld-1.jpg');
    expect(name).not.toContain('.exe');
  });

  it('cannot be made to carry a path, a traversal or a quote through the label', () => {
    const name = enterpriseCopyFilename({
      submissionId: 'sub-1',
      fieldId: 'fld-1',
      label: '../../etc/passwd"',
      originalFilename: null,
      extension: '.pdf',
    });
    expect(name).not.toMatch(/[\\/"]/);
    expect(name).not.toContain('..');
  });

  it('is unique per submission AND per field, so two uploads never collide', () => {
    const a = enterpriseCopyFilename({ submissionId: 's1', fieldId: 'f1', label: 'Photo', originalFilename: null, extension: '.jpg' });
    const b = enterpriseCopyFilename({ submissionId: 's1', fieldId: 'f2', label: 'Photo', originalFilename: null, extension: '.jpg' });
    const c = enterpriseCopyFilename({ submissionId: 's2', fieldId: 'f1', label: 'Photo', originalFilename: null, extension: '.jpg' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('ignores a bogus proved extension rather than trusting it blindly', () => {
    const name = enterpriseCopyFilename({
      submissionId: 's1',
      fieldId: 'f1',
      label: 'Photo',
      originalFilename: null,
      extension: '.././sh',
    });
    expect(name).toBe('Photo - s1 - f1.txt');
  });
});

describe('configuring a file upload field', () => {
  const base = { label: 'Passport photo', fieldType: 'file', required: true };

  it('accepts a complete configuration', () => {
    expect(
      parseSaveCustomerField({ ...base, allowedFileKinds: 'image', maxFileBytes: 5 * 1024 * 1024, description: ' Both sides ' }),
    ).toMatchObject({
      fieldType: 'file',
      allowedFileKinds: 'image',
      maxFileBytes: 5 * 1024 * 1024,
      description: 'Both sides',
    });
  });

  it('defaults the cap rather than leaving a field with no limit', () => {
    expect(parseSaveCustomerField({ ...base, allowedFileKinds: 'pdf' }).maxFileBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
  });

  it('refuses a cap above the ceiling, or below the floor', () => {
    expect(() => parseSaveCustomerField({ ...base, allowedFileKinds: 'pdf', maxFileBytes: UPLOAD_MAX_BYTES_CEILING + 1 })).toThrow(
      /between/,
    );
    expect(() => parseSaveCustomerField({ ...base, allowedFileKinds: 'pdf', maxFileBytes: 10 })).toThrow(/between/);
    expect(() => parseSaveCustomerField({ ...base, allowedFileKinds: 'pdf', maxFileBytes: 1.5 })).toThrow(/integer/);
  });

  it('refuses an unknown kind — the allowlist cannot be widened from a request', () => {
    expect(() => parseSaveCustomerField({ ...base, allowedFileKinds: 'anything' })).toThrow(/must be one of/);
    expect(() => parseSaveCustomerField({ ...base })).toThrow(/must be one of/);
  });

  it('refuses upload configuration on a NON-upload field instead of ignoring it', () => {
    expect(() => parseSaveCustomerField({ label: 'Name', fieldType: 'text', allowedFileKinds: 'image' })).toThrow(
      /only to a file upload field/,
    );
    expect(() => parseSaveCustomerField({ label: 'Name', fieldType: 'text', maxFileBytes: 1024 })).toThrow(
      /only to a file upload field/,
    );
  });

  it('a text field stays exactly as it was: no kinds, no cap', () => {
    expect(parseSaveCustomerField({ label: 'Name', fieldType: 'text' })).toMatchObject({
      fieldType: 'text',
      allowedFileKinds: null,
      maxFileBytes: null,
      description: null,
    });
  });

  it('refuses a field type outside the allowlist', () => {
    expect(() => parseSaveCustomerField({ label: 'X', fieldType: 'signature' })).toThrow(/fieldType must be one of/);
  });
});

describe('the legacy upload types keep working', () => {
  it('a `pdf` field is type-checked as PDF-only at the default cap', () => {
    const rules = uploadRulesFor({ id: 'f', label: 'ID proof', field_type: 'pdf', allowed_file_kinds: null, max_file_bytes: null });
    expect(rules).toMatchObject({ kind: 'pdf', maxBytes: DEFAULT_UPLOAD_MAX_BYTES });
    expect(isTypeCheckedUpload('pdf')).toBe(true);
  });

  it('an `excel` field is NOT routed through the byte allowlist — a .xlsx is a zip', () => {
    // Routing it through acceptUpload would start refusing uploads that live
    // forms accept today. It is excluded explicitly rather than by accident.
    expect(isTypeCheckedUpload('excel')).toBe(false);
    expect(isTypeCheckedUpload('text')).toBe(false);
  });

  it('a `file` row written before the config columns existed still has usable rules', () => {
    expect(
      uploadRulesFor({ id: 'f', label: 'Photo', field_type: 'file', allowed_file_kinds: null, max_file_bytes: null }),
    ).toMatchObject({ kind: 'image_pdf', maxBytes: DEFAULT_UPLOAD_MAX_BYTES });
  });
});
