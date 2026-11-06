'use client';

import { useRef, useState } from 'react';
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  describeByteSize,
  describeUploadKind,
  inspectUpload,
  uploadAcceptAttribute,
  type ConsentFormFileKind,
  type UploadRejectionReason,
} from '@dpdp/shared';

/**
 * The respondent's side of a file-upload field: choose a photo or PDF, see
 * what was chosen, replace it or take it off, and be told clearly when a file
 * will not do.
 *
 * Everything this component checks, the backend checks again — see
 * backend/src/modules/consent/consent-form-uploads.ts. It runs the SAME shared
 * `inspectUpload` over the SAME first bytes, which means a respondent learns
 * their 40 MB photo is too big before uploading it rather than after, and
 * learns a renamed executable is refused at the same moment. Nothing here is
 * a security control: the `accept` attribute is a hint to the file chooser,
 * and the browser's own `File.type` is never consulted.
 */

/** Enough bytes for every signature in UPLOAD_TYPES, with room to spare. We
 *  read only the head — reading a 20 MB file into memory to look at twelve
 *  bytes would stall a phone for no reason. */
const SNIFF_BYTES = 64;

const MESSAGES: Record<UploadRejectionReason, (ctx: { kinds: string; limit: string }) => string> = {
  TOO_LARGE: ({ limit }) => `That file is too large. The most this question accepts is ${limit}.`,
  EMPTY: () => 'That file appears to be empty. Please choose it again.',
  TYPE_NOT_ALLOWED: ({ kinds }) => `This question accepts ${kinds} only.`,
  TYPE_UNRECOGNISED: ({ kinds }) => `That does not look like ${kinds}. Please choose a different file.`,
};

export function FileUploadField({
  fieldId,
  label,
  required,
  description,
  kind,
  maxFileBytes,
  file,
  onPick,
}: {
  fieldId: string;
  label: string;
  required: boolean;
  description: string | null;
  kind: ConsentFormFileKind;
  /** Null only for a row written before the cap column existed; the backend
   *  applies the same default, so the two never disagree. */
  maxFileBytes: number | null;
  file: File | undefined;
  /** `null` clears the field. The parent owns the chosen file, so a rejected
   *  pick never becomes the submitted one. */
  onPick: (file: File | null) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const maxBytes = maxFileBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const kinds = describeUploadKind(kind);
  const limit = describeByteSize(maxBytes);

  async function choose(picked: File | undefined): Promise<void> {
    setProblem(null);
    if (!picked) return;
    const head = new Uint8Array(await picked.slice(0, SNIFF_BYTES).arrayBuffer());
    // The real size comes from the File, not from the sniffed head.
    const verdict = inspectUpload(head, { kind, maxBytes: Number.MAX_SAFE_INTEGER });
    if (picked.size > maxBytes) {
      reject('TOO_LARGE');
      return;
    }
    if (picked.size === 0) {
      reject('EMPTY');
      return;
    }
    if (!verdict.ok) {
      reject(verdict.reason ?? 'TYPE_UNRECOGNISED');
      return;
    }
    onPick(picked);
  }

  function reject(reason: UploadRejectionReason): void {
    setProblem(MESSAGES[reason]({ kinds, limit }));
    onPick(null);
    // Clear the native input too, or the browser keeps showing the rejected
    // filename beside a message saying it was not accepted.
    if (inputRef.current) inputRef.current.value = '';
  }

  function clear(): void {
    setProblem(null);
    onPick(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div style={{ margin: '0.75em 0' }}>
      <label htmlFor={`field-${fieldId}`}>
        {label}
        {required ? ' *' : ''}
      </label>
      {description && (
        <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 6px' }}>
          {description}
        </p>
      )}
      <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 6px' }}>
        {kinds} · up to {limit}
      </p>

      <input
        ref={inputRef}
        id={`field-${fieldId}`}
        type="file"
        accept={uploadAcceptAttribute(kind)}
        onChange={(e) => void choose(e.target.files?.[0])}
        // `required` on the native input only, and only while nothing is
        // chosen: once a file is held in state the input itself is empty
        // again (a replace clears it), and a stale `required` would block a
        // submission that does have a file.
        required={required && !file}
      />

      {file && (
        <div
          className="panel"
          style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, padding: '8px 10px' }}
        >
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {file.name}
            <span className="muted"> · {describeByteSize(file.size)}</span>
          </span>
          <button type="button" onClick={() => inputRef.current?.click()}>
            Replace
          </button>
          <button type="button" onClick={clear}>
            Remove
          </button>
        </div>
      )}

      {problem && (
        <div className="error" style={{ marginTop: 8 }}>
          {problem}
        </div>
      )}
    </div>
  );
}
