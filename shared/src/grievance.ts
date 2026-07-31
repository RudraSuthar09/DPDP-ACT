/**
 * Grievance-specific contracts (FR-GRV-02) — deliberately NOT in `request.ts`.
 * That file's own header says so: "if you are tempted to add
 * `complaintCategory` here, that is the signal you are in the wrong file."
 * This is the right file — everything below is meaningful only for a
 * `request_type = 'grievance'` ticket, and DPRequest's own equivalent (rights
 * type, when it lands) belongs in a `dprequest.ts` sibling, never here.
 */

/**
 * The Section 13 grievance taxonomy this platform offers at intake. Not text
 * from the Act itself (Section 13 establishes the grievance-redressal
 * *mechanism*, not a fixed list of complaint types) — a practical taxonomy
 * covering the substantive rights a complaint is usually about, plus 'other'
 * so intake never blocks on a category that doesn't fit. A Grievance Officer
 * may recategorise after intake; see `grievance_details.set_by`.
 */
export const GRIEVANCE_CATEGORIES = [
  'consent_violation',
  'unauthorized_sharing',
  'data_not_corrected',
  'data_not_erased',
  'excessive_collection',
  'no_response_to_rights_request',
  'marketing_after_opt_out',
  'security_or_breach_concern',
  'other',
] as const;
export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];

export const GRIEVANCE_CATEGORY_LABELS: Record<GrievanceCategory, string> = {
  consent_violation: 'Processed without valid consent',
  unauthorized_sharing: 'Shared with a third party without consent',
  data_not_corrected: 'Correction request not honoured',
  data_not_erased: 'Erasure request not honoured',
  excessive_collection: 'Collected more data than necessary',
  no_response_to_rights_request: 'No response to a rights request',
  marketing_after_opt_out: 'Marketing continued after opt-out or withdrawal',
  security_or_breach_concern: 'Security or data-breach concern',
  other: 'Other',
};
