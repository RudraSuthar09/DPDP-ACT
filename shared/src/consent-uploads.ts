/**
 * File-upload fields: which kinds of file a form may accept, how big, and how
 * a file's REAL type is established.
 *
 * Defined once here because three places must agree and two of them cannot be
 * trusted: the builder (what the form owner configures), the public form (what
 * the respondent's browser offers and pre-validates, for a decent error
 * message) and the backend (the only authoritative check). A browser's
 * `accept` attribute, a `File.type` and a filename are all respondent-supplied
 * hints — the server re-derives everything from the bytes.
 */

/** What a file-upload field accepts. Deliberately three coarse choices rather
 *  than a free MIME list: a form owner is choosing "photos", "PDFs" or "both",
 *  not editing a content-type allowlist, and a narrow enum cannot be widened
 *  by a crafted request into accepting something executable. */
export const CONSENT_FORM_FILE_KINDS = ['image', 'pdf', 'image_pdf'] as const;
export type ConsentFormFileKind = (typeof CONSENT_FORM_FILE_KINDS)[number];

/** The default cap offered in the builder. Comfortable for a phone photo or a
 *  scanned document, small enough that one submission cannot monopolise the
 *  encrypted relay row it travels in. */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** The hard ceiling. A form owner may lower the cap but never raise it past
 *  this: the bytes ride through `consent_form_submission_deliveries` as one
 *  encrypted payload, and that is a transit buffer, not a file store. */
export const UPLOAD_MAX_BYTES_CEILING = 25 * 1024 * 1024;
/** The floor, so a field cannot be configured to accept nothing at all. */
export const UPLOAD_MIN_BYTES = 1024;

/**
 * Every content type an upload field may yield, with the extension the SERVER
 * gives the stored file and the magic bytes that prove the type.
 *
 * No entry is executable, no entry is a container that can carry executable
 * content (no zip, no Office macro format, no SVG — SVG is XML and scripts),
 * and the list is closed: a type absent from here is refused, rather than
 * passed through because it "looked like an image".
 */
export interface UploadTypeSpec {
  contentType: string;
  /** The extension the server appends. Never taken from the filename. */
  extension: string;
  /** Leading-byte signatures, any one of which identifies this type. */
  signatures: readonly { readonly offset: number; readonly bytes: readonly number[] }[];
}

export const UPLOAD_TYPES: readonly UploadTypeSpec[] = [
  {
    contentType: 'image/jpeg',
    extension: '.jpg',
    signatures: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  },
  {
    contentType: 'image/png',
    extension: '.png',
    signatures: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  {
    contentType: 'image/webp',
    extension: '.webp',
    // 'RIFF' .... 'WEBP' — the second half is checked in matchesSignature, so
    // a bare RIFF container (a WAV, say) does not pass as an image.
    signatures: [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }],
  },
  {
    contentType: 'image/heic',
    extension: '.heic',
    // ISO-BMFF 'ftyp' box; the brand is checked in matchesSignature.
    signatures: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  },
  {
    contentType: 'application/pdf',
    extension: '.pdf',
    signatures: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
  },
];

/** The content types each configured kind permits. */
export function uploadTypesFor(kind: ConsentFormFileKind): UploadTypeSpec[] {
  return UPLOAD_TYPES.filter((t) => {
    const isPdf = t.contentType === 'application/pdf';
    return kind === 'pdf' ? isPdf : kind === 'image' ? !isPdf : true;
  });
}

/** The `accept` attribute for a file input. A HINT for the file chooser only —
 *  never relied on, because a respondent can submit anything regardless. */
export function uploadAcceptAttribute(kind: ConsentFormFileKind): string {
  return uploadTypesFor(kind)
    .map((t) => t.contentType)
    .join(',');
}

/** Plain words for the form and the builder, e.g. "JPG, PNG, WEBP, HEIC or PDF". */
export function describeUploadKind(kind: ConsentFormFileKind): string {
  const names = uploadTypesFor(kind).map((t) => t.extension.slice(1).toUpperCase());
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export function describeByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** Why an upload was refused. Stable codes, so the public form can say
 *  something specific without the backend sending it prose. */
export type UploadRejectionReason = 'TOO_LARGE' | 'EMPTY' | 'TYPE_NOT_ALLOWED' | 'TYPE_UNRECOGNISED';

export interface UploadInspection {
  ok: boolean;
  /** The type proved by the bytes — never the one the client claimed. */
  contentType: string | null;
  extension: string | null;
  byteSize: number;
  reason: UploadRejectionReason | null;
}

/**
 * Establishes what a file ACTUALLY is, from its first bytes, and whether this
 * field accepts it.
 *
 * Pure and dependency-free, so the same function runs on the server (where its
 * verdict is binding) and in the browser (where it only buys a faster, clearer
 * error). It never looks at the filename or at any client-supplied content
 * type: a .pdf whose bytes begin with `MZ` is refused, and a Windows
 * executable renamed to .jpg is refused, which is the whole point.
 */
export function inspectUpload(
  bytes: Uint8Array,
  options: { kind: ConsentFormFileKind; maxBytes: number },
): UploadInspection {
  const byteSize = bytes.byteLength;
  const base: UploadInspection = { ok: false, contentType: null, extension: null, byteSize, reason: null };
  if (byteSize === 0) return { ...base, reason: 'EMPTY' };
  if (byteSize > options.maxBytes) return { ...base, reason: 'TOO_LARGE' };

  const matched = UPLOAD_TYPES.find((spec) => matchesSignature(bytes, spec));
  if (!matched) return { ...base, reason: 'TYPE_UNRECOGNISED' };
  const allowed = uploadTypesFor(options.kind).some((t) => t.contentType === matched.contentType);
  if (!allowed) {
    return { ...base, contentType: matched.contentType, extension: matched.extension, reason: 'TYPE_NOT_ALLOWED' };
  }
  return { ok: true, contentType: matched.contentType, extension: matched.extension, byteSize, reason: null };
}

function matchesSignature(bytes: Uint8Array, spec: UploadTypeSpec): boolean {
  const hit = spec.signatures.some(({ offset, bytes: sig }) => {
    if (bytes.byteLength < offset + sig.length) return false;
    return sig.every((b, i) => bytes[offset + i] === b);
  });
  if (!hit) return false;
  // Two container formats need a second look, or unrelated files sharing the
  // same outer header would be accepted as images.
  if (spec.contentType === 'image/webp') return hasAscii(bytes, 8, 'WEBP');
  if (spec.contentType === 'image/heic') {
    return ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1'].some((brand) => hasAscii(bytes, 8, brand));
  }
  return true;
}

function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
