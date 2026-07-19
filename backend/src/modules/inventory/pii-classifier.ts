/**
 * Tier-1 PII classification (master doc §4.5): a rule/dictionary pass over column
 * NAMES only — never data values (I1) — using an Indian lexicon. Deterministic
 * and explainable, which is what the ~80% common case needs.
 *
 * Every result is a SUGGESTION. Under DPDP the client is the Data Fiduciary and
 * owns the determination; the platform advises, never decides (which is why the
 * pii_category column is nullable and a human confirms it). This function returns
 * a hint, not a verdict.
 */
const PII_LEXICON: Array<[RegExp, string]> = [
  [/aadhaar|uidai/i, 'aadhaar'],
  [/(^|[^a-z])pan([^a-z]|_?(no|number|card)|$)/i, 'pan'],
  [/abha/i, 'abha_id'],
  [/upi|\bvpa\b/i, 'upi'],
  [/mobile|phone|msisdn|contact_?(no|number)/i, 'phone'],
  [/e[-_]?mail/i, 'email'],
  [/(^|[^a-z])dob([^a-z]|$)|birth/i, 'date_of_birth'],
  [/mrn|medical_?record/i, 'medical_record_number'],
  [/passport/i, 'passport'],
  [/pin_?code|postal|zip/i, 'postal_code'],
  [/address/i, 'address'],
  [/name/i, 'name'],
];

export function classifyPii(columnName: string): string | null {
  const name = columnName.toLowerCase();
  for (const [pattern, category] of PII_LEXICON) {
    if (pattern.test(name)) {
      return category;
    }
  }
  return null;
}
