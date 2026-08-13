/**
 * Conservative, CLIENT-SIDE masking of obviously-sensitive columns for the
 * Phase-2 raw-data viewer.
 *
 * IMPORTANT — this is a POC heuristic, NOT the permanent PII policy. The
 * authoritative PII classification lives in the backend Data Inventory
 * (pii-classifier.ts, which classifies by COLUMN NAME). This viewer runs fully
 * in-browser and does not (in this phase) round-trip column names to that
 * classifier, so it applies a small, deliberately over-cautious header-name
 * heuristic instead: when in doubt, mask. A later phase can wire the real
 * classifier. The heuristic mirrors that classifier's lexicon.
 */

type Masker = (value: string) => string;

/** Show only the last `keep` characters; mask the rest. */
function tail(keep: number): Masker {
  return (v) => {
    const s = v.trim();
    if (s.length <= keep) return s.length ? '•'.repeat(s.length) : s;
    return '•'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep);
  };
}

/** Email: first char + masked local part + domain. */
const maskEmail: Masker = (v) => {
  const s = v.trim();
  const at = s.indexOf('@');
  if (at <= 0) return s ? '•'.repeat(s.length) : s;
  return s[0] + '•'.repeat(Math.max(1, at - 1)) + s.slice(at);
};

interface SensitiveRule {
  test: RegExp;
  mask: Masker;
  label: string;
}

// Ordered; first match wins. Patterns match against a normalised header name.
const RULES: SensitiveRule[] = [
  { test: /aadhaar|aadhar|uidai/, mask: tail(4), label: 'Aadhaar' },
  { test: /\bpan\b|pan[_ ]?(no|number|card)/, mask: tail(1), label: 'PAN' },
  { test: /passport/, mask: tail(2), label: 'Passport' },
  { test: /account|acct|ifsc|iban|card[_ ]?(no|number)/, mask: tail(4), label: 'Financial' },
  { test: /e[-_ ]?mail/, mask: maskEmail, label: 'Email' },
  { test: /mobile|phone|msisdn|contact[_ ]?(no|number)/, mask: tail(2), label: 'Phone' },
  { test: /dob|date[_ ]?of[_ ]?birth|birth/, mask: () => '••/••/••••', label: 'Date of birth' },
];

export interface ColumnMask {
  sensitive: boolean;
  label: string | null;
  mask: (value: string) => string;
}

const IDENTITY: ColumnMask = { sensitive: false, label: null, mask: (v) => v };

/** Decide masking for a column purely from its header name. */
export function maskForHeader(header: string): ColumnMask {
  const norm = header.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(norm)) {
      return { sensitive: true, label: rule.label, mask: rule.mask };
    }
  }
  return IDENTITY;
}
