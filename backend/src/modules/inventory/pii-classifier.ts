/**
 * Tier-1 PII classification (master doc §4.5, FR-INV-03/04): a rule/dictionary
 * pass over column NAMES and comment/header TEXT only — never data values (I1)
 * — using an Indian lexicon. Deterministic and explainable, which is what the
 * ~80% common case needs.
 *
 * Every result is a SUGGESTION with a confidence score, never an auto-applied
 * verdict. Under DPDP the client is the Data Fiduciary and owns the
 * determination; the platform advises, never decides. Confidence reflects how
 * specific/unambiguous the matched pattern is, not any property of real data
 * (this function never sees real data — see the callers listed below, all of
 * which pass a column/field NAME or a human-typed label, never a row value):
 *   - high   — a near-unique identifier pattern (aadhaar, PAN, ABHA, UPI VPA,
 *              passport, MRN, biometric markers). Collision with a
 *              non-personal field is very unlikely.
 *   - medium — common and fairly specific (phone, email, DOB, PIN/postal
 *              code), but occasionally ambiguous with an unrelated field
 *              that happens to share the word.
 *   - low    — generic words ("name", "address") that also appear on plenty
 *              of non-personal-data fields (a product name, a business
 *              address), so a human should look twice.
 */
export type PiiConfidence = 'high' | 'medium' | 'low';

export interface PiiSuggestion {
  category: string;
  confidence: PiiConfidence;
}

const PII_LEXICON: Array<[RegExp, string, PiiConfidence]> = [
  // High confidence — near-unique identifiers.
  [/aadhaar|uidai/i, 'aadhaar', 'high'],
  [/(^|[^a-z])pan([^a-z]|_?(no|number|card)|$)/i, 'pan', 'high'],
  [/abha/i, 'abha_id', 'high'],
  [/upi|\bvpa\b/i, 'upi', 'high'],
  [/passport/i, 'passport', 'high'],
  [/mrn|medical_?record/i, 'medical_record_number', 'high'],
  [
    /biometric|finger ?print|iris_?(scan|id)|retina_?scan|facial_?(scan|recognition|id)|voice_?print/i,
    'biometric',
    'high',
  ],
  // Medium confidence — common and fairly specific.
  [/mobile|phone|msisdn|contact_?(no|number)/i, 'phone', 'medium'],
  [/e[-_]?mail/i, 'email', 'medium'],
  [/(^|[^a-z])dob([^a-z]|$)|birth/i, 'date_of_birth', 'medium'],
  [/pin_?code|postal|zip/i, 'postal_code', 'medium'],
  // Low confidence — generic words also common on non-personal-data fields.
  [/address/i, 'address', 'low'],
  [/name/i, 'name', 'low'],
];

/**
 * Classify a column name, header, or human-typed label. Callers today:
 * InventoryService.discover() (a SchemaSource column NAME — S4, never a row),
 * RegisterImportService.preview()/commit() (a CSV HEADER name — same S4
 * guarantee), and RegisterService's classification endpoints (the register
 * entry's own free-text `category`/`description`, i.e. what a human already
 * typed — still never a data VALUE). No call path in this codebase feeds a
 * customer record into this function.
 */
export function classifyPii(text: string): PiiSuggestion | null {
  const normalized = text.toLowerCase();
  for (const [pattern, category, confidence] of PII_LEXICON) {
    if (pattern.test(normalized)) {
      return { category, confidence };
    }
  }
  return null;
}
