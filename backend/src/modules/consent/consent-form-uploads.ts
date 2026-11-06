import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  inspectUpload,
  type ConsentFormFileKind,
  type UploadRejectionReason,
} from '@dpdp/shared';

/**
 * The AUTHORITATIVE check on a submitted file. The public form does the same
 * checks in the browser, but only so the respondent gets a fast, clear error;
 * nothing it concludes is trusted here.
 *
 * Three things are deliberately re-derived from the bytes rather than taken
 * from the request:
 *
 *   1. THE TYPE. A respondent controls the filename and the content type their
 *      browser sends. `script.exe` renamed `photo.jpg`, with
 *      `Content-Type: image/jpeg`, is refused because its leading bytes are
 *      not any allowed type's. The allowlist is closed: an unrecognised type
 *      is refused rather than passed through.
 *   2. THE SIZE. Measured on the decoded bytes, not on a client-sent number,
 *      and checked against the field's own cap.
 *   3. THE EXTENSION. Appended by us from the proved type, so a respondent
 *      cannot choose what a file is called on the client's disk, and cannot
 *      smuggle a second extension or a path fragment through the name.
 *
 * A failure here must fail the SUBMISSION, before any consent is recorded.
 * Accepting the consent and dropping the file would leave the client with a
 * consent record whose evidence is missing and no way to know.
 */

/** What a field needs to validate against. Read from the field's own
 *  configuration — never from the request. */
export interface UploadFieldRules {
  fieldId: string;
  label: string;
  kind: ConsentFormFileKind;
  maxBytes: number;
}

export interface AcceptedUpload {
  fieldId: string;
  label: string;
  bytes: Buffer;
  /** Proved from the bytes. */
  contentType: string;
  /** Appended by us, from the proved type. */
  extension: string;
  byteSize: number;
}

/** Decodes and validates one submitted file. Throws BadRequestException with a
 *  message a respondent can act on — and which says nothing about the
 *  client's storage, the tenant, or any id. */
export function acceptUpload(
  rules: UploadFieldRules,
  contentBase64: string,
): AcceptedUpload {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(contentBase64, 'base64');
  } catch {
    throw new BadRequestException(`"${rules.label}" could not be read. Please choose the file again.`);
  }
  // Buffer.from is lenient: it silently drops anything that is not base64
  // rather than throwing. An input that decodes to nothing is a broken
  // upload, not an empty file, and inspectUpload reports it as EMPTY below.
  const verdict = inspectUpload(bytes, { kind: rules.kind, maxBytes: rules.maxBytes });
  if (!verdict.ok) {
    throw new BadRequestException(explain(rules, verdict.reason!, verdict.byteSize));
  }
  return {
    fieldId: rules.fieldId,
    label: rules.label,
    bytes,
    contentType: verdict.contentType!,
    extension: verdict.extension!,
    byteSize: verdict.byteSize,
  };
}

function explain(rules: UploadFieldRules, reason: UploadRejectionReason, byteSize: number): string {
  const limit = `${Math.round(rules.maxBytes / (1024 * 1024))} MB`;
  switch (reason) {
    case 'TOO_LARGE':
      return `"${rules.label}" is too large (${Math.round(byteSize / (1024 * 1024))} MB). The limit is ${limit}.`;
    case 'EMPTY':
      return `"${rules.label}" is empty. Please choose the file again.`;
    case 'TYPE_NOT_ALLOWED':
    case 'TYPE_UNRECOGNISED':
      // One message for both: telling a caller which types we DID recognise
      // helps someone probing the allowlist more than it helps a respondent,
      // who is told what this field accepts by the form itself.
      return `"${rules.label}" is not a file type this form accepts.`;
  }
}

/**
 * A field row's upload rules.
 *
 * The two LEGACY types get fixed rules rather than a migration that rewrites
 * live forms: `pdf` means PDFs at the default cap, and `excel` predates this
 * allowlist entirely — spreadsheets are not in UPLOAD_TYPES (a .xlsx is a zip,
 * which is exactly the kind of container this allowlist excludes), so an
 * `excel` field keeps its own untyped behaviour and is NOT routed through
 * acceptUpload. Callers check isFileField first and only reach here for a
 * field this function can actually describe.
 */
export function uploadRulesFor(field: {
  id: string;
  label: string;
  field_type: string;
  allowed_file_kinds: string | null;
  max_file_bytes: number | null;
}): UploadFieldRules {
  if (field.field_type === 'file') {
    // Both columns are guaranteed present for a 'file' field by the DTO and by
    // the table's own CHECK. Falling back rather than asserting keeps a row
    // written before that constraint existed from failing a submission.
    return {
      fieldId: field.id,
      label: field.label,
      kind: (field.allowed_file_kinds as ConsentFormFileKind | null) ?? 'image_pdf',
      maxBytes: field.max_file_bytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    };
  }
  return { fieldId: field.id, label: field.label, kind: 'pdf', maxBytes: DEFAULT_UPLOAD_MAX_BYTES };
}

/** Whether a field's submitted file is checked by acceptUpload at all. The
 *  legacy `excel` type is deliberately excluded: see uploadRulesFor. */
export function isTypeCheckedUpload(fieldType: string): boolean {
  return fieldType === 'file' || fieldType === 'pdf';
}
