/**
 * Data-source metadata + per-source access mode (Phase 1 of the Gateway line of
 * work). See I1 / §2.1 in the master doc for the two-mode contract.
 *
 * THESE ARE METADATA TYPES ONLY. There is deliberately no field here — and no
 * type anywhere — for a customer value, a row, a payload, or a credential. A
 * data source describes a CONNECTION POINT and its configured access mode; it
 * never carries the data behind it.
 */

/** The kinds of source the architecture will eventually connect to. Phase 1
 *  treats these as pure metadata — no connector implements any of them yet. The
 *  safe-first order is excel/csv/filesystem, then the databases. */
export const DATA_SOURCE_KINDS = [
  'excel',
  'csv',
  'filesystem',
  'postgresql',
  'mysql',
  'sqlserver',
] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];

/**
 * The per-source access mode (I1/§2.1).
 *
 * - `metadata_only`  — the DEFAULT. Structure/description only; no raw values.
 * - `gateway_connected` — a CONFIGURATION STATE only. It records that a source
 *   is explicitly permitted to allow FUTURE Gateway-based raw access. In Phase 1
 *   it grants nothing: there is no Gateway, no connector, no raw-read path, so
 *   any raw-data operation fails closed.
 */
export const DATA_ACCESS_MODES = ['metadata_only', 'gateway_connected'] as const;
export type DataAccessMode = (typeof DATA_ACCESS_MODES)[number];

export type DataSourceStatus = 'active' | 'tombstoned';

/** The API's view of a data source. No value/secret fields, by design. */
export interface DataSource {
  id: string;
  name: string;
  sourceKind: DataSourceKind;
  dataAccessMode: DataAccessMode;
  status: DataSourceStatus;
  /** Non-secret human identifier only (never a credential/connection secret). */
  connectionHint: string | null;
  /**
   * Phase 3G-1: the client-chosen COLUMN NAME that identifies a customer in this
   * source (e.g. 'email', 'customer_id') — never a value, never inferred/assumed.
   * NULL until a human explicitly configures it. Reusable by any DPDP module that
   * later needs "which existing customer is this" (Consent/Grievance/DSR/Breach).
   */
  identityColumn: string | null;
  createdAt: string;
  updatedAt: string;
  modeLastChangedAt: string | null;
}
