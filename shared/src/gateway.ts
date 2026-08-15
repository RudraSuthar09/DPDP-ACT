/**
 * GATEWAY — Phase 3A CONTRACTS (the security contract, not the security).
 * ===========================================================================
 *
 * This file defines the wire shapes, names, scopes, TTLs and documented rules
 * for the future Gateway / Local Data Agent (I1 Mode-B, per-source raw access).
 * It is the same "define the seam now, build the system later" move the codebase
 * already makes for S2–S5 in `seams.ts`: those interfaces have only a Postgres
 * implementation today; these have NO implementation at all yet.
 *
 * READ THIS FIRST — WHAT THESE TYPES ARE, AND WHAT THEY ARE NOT.
 *
 * The Phase-3A types/contracts are SECURITY CONTRACTS, not implementations of
 * the security mechanisms. A shape that names a field does not enforce the rule
 * that field exists to serve. Concretely:
 *
 *   - token types do NOT by themselves make tokens non-replayable;
 *   - nonce types do NOT by themselves enforce single-use;
 *   - Origin constants do NOT by themselves enforce Origin validation;
 *   - device public-key types do NOT by themselves establish device identity;
 *   - audit metadata types do NOT by themselves guarantee audit safety;
 *   - filesystem path types do NOT by themselves enforce path containment.
 *
 * Every enforcement mechanism (the loopback listener that checks Origin, the
 * Azure store that marks a nonce consumed, the agent that canonicalises a path
 * and refuses one outside an allowed root, the crypto that proves device
 * identity) belongs to a LATER phase (3B onward). Nothing here runs. Nothing
 * here reads a customer value. Nothing here opens a port, a socket, a file, or a
 * database. There is no connector implementation, no endpoint, no listener.
 *
 * The raw-data boundary these contracts exist to protect (unchanged from I1):
 *
 *     Customer data source
 *            ↓
 *     Local Agent process memory          ← transient
 *            ↓  (direct localhost, NEVER via Azure)
 *     Authorized browser memory / UI      ← transient
 *            ↓
 *     cleared → gone
 *
 *   Central Azure / central PostgreSQL / logs : NO RAW CUSTOMER VALUES, EVER.
 *   Central audit                             : METADATA ONLY.
 *
 * Types only — no business logic (see CLAUDE.md, and every other file in
 * `shared/src`). Guarded by backend/src/modules/gateway/*.spec.ts.
 */

import type { DataSourceKind } from './datasource';

// ===========================================================================
// §1  Control plane vs data plane — the load-bearing separation
// ===========================================================================
//
// CONTROL PLANE  (Agent → outbound HTTPS → Azure):
//   enrollment, device identity, heartbeat, authorization, pairing/session
//   negotiation, revocation, configuration metadata, audit metadata.
//   Carries METADATA ONLY. Never a customer value.
//
// DATA PLANE  (Browser → localhost 127.0.0.1 → Local Agent → customer data):
//   discover/search/read/metadata of the customer's own source.
//   Raw values may transit this plane transiently. They MUST NOT be routed
//   through Azure — the browser and the agent are on the same machine.
//
// These are enumerated as documentation constants so the split is greppable and
// so a future reviewer can point at "which plane is this?" for any operation.

export const GATEWAY_PLANES = ['control', 'data'] as const;
export type GatewayPlane = (typeof GATEWAY_PLANES)[number];

// ===========================================================================
// §2  Localhost transport + Origin security (V1 decision: HTTP on 127.0.0.1)
// ===========================================================================

/**
 * The agent's data-plane listener binds ONLY to loopback. Never 0.0.0.0, never
 * a LAN IP, never a public IP. 127.0.0.1 is not routable off-host, so no inbound
 * firewall exposure exists — the browser reaching it is a same-machine call.
 *
 * (This constant DOCUMENTS the binding decision. It does not perform the bind —
 * that is the agent, a later phase.)
 */
export const GATEWAY_LOOPBACK_HOST = '127.0.0.1' as const;

/**
 * V1 uses plain HTTP on loopback (see the Phase-3A design doc). TLS/mTLS on the
 * loopback hop is documented there as a FUTURE hardening option, deliberately
 * out of scope for 3A. This constant records the selected transport for V1.
 */
export const GATEWAY_V1_TRANSPORT = 'http-loopback' as const;

/**
 * The EXACT origins the future agent will accept on a data-plane request. Two
 * controls exist together and both are required (documented, not enforced here):
 *
 *   1. Origin allowlist (this list) — a malicious website's fetch to the agent
 *      carries its own Origin, which is not on this list, so it is rejected. A
 *      page cannot forge the Origin header (browsers forbid it to script).
 *   2. A custom, non-simple auth header (GATEWAY_AUTH_HEADER) — its presence
 *      forces a CORS preflight, so a cross-site "simple request" cannot reach the
 *      agent's real handler at all without the browser first checking CORS.
 *
 * MUST be exact strings. No '*', no substring match, no loose hostname match —
 * the gateway-contract guard test fails the build if a wildcard appears here.
 * (Placeholder dev/staging/prod origins; the real deployment origins are wired
 * when the agent is built.)
 */
export const GATEWAY_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://app.dpdp-shield.example',
] as const;
export type GatewayAllowedOrigin = (typeof GATEWAY_ALLOWED_ORIGINS)[number];

/**
 * The custom request header the browser must send on every data-plane call. A
 * non-simple header by definition, so it triggers CORS preflight (see above).
 * Naming it here does NOT validate it — the agent validates it (later phase).
 */
export const GATEWAY_AUTH_HEADER = 'x-dpdp-gateway-session' as const;

// ===========================================================================
// §3  Device identity (contract only — no keypair is generated here)
// ===========================================================================

export const GATEWAY_DEVICE_STATUSES = ['active', 'revoked'] as const;
export type GatewayDeviceStatus = (typeof GATEWAY_DEVICE_STATUSES)[number];

export const GATEWAY_AGENT_PLATFORMS = ['windows', 'linux'] as const;
export type GatewayAgentPlatform = (typeof GATEWAY_AGENT_PLATFORMS)[number];

/**
 * What the DEVICE sends Azure at enrollment. The device generates an asymmetric
 * keypair locally; ONLY the public key and identifying metadata are sent. The
 * PRIVATE KEY is never modeled server-side — there is deliberately no field for
 * it anywhere in this file, because it must never leave the device, never reach
 * Azure, never reach the browser, and never be logged. (Contract; the actual key
 * generation, storage and proof happen in a later phase.)
 */
export interface DeviceEnrollmentRequest {
  /** Stable device id, generated on the device. */
  deviceId: string;
  /** PEM/DER-encoded PUBLIC key only. Never the private key. */
  publicKey: string;
  /** Which tenant this device is being bound to (single tenant per device). */
  tenantId: string;
  platform: GatewayAgentPlatform;
  agentVersion: string;
  /** Human-friendly label, e.g. "Finance workstation". Non-secret. */
  displayName: string;
}

/** Azure's stored view of an enrolled device — public identity + status only. */
export interface DeviceIdentity {
  deviceId: string;
  tenantId: string;
  publicKey: string;
  status: GatewayDeviceStatus;
  platform: GatewayAgentPlatform;
  agentVersion: string;
  displayName: string;
  enrolledAt: string;
  lastHeartbeatAt: string | null;
}

// ===========================================================================
// §4  Pairing nonce (contract only — single-use is enforced later, not here)
// ===========================================================================

/** How long a freshly-issued pairing nonce is valid. Short by design. */
export const GATEWAY_PAIRING_NONCE_TTL_SECONDS = 60 as const;

/**
 * The record Azure holds for a pairing nonce it issued. The `nonce` value itself
 * is an OPAQUE random string (no customer data, no meaning encoded in it). The
 * binding fields scope it to exactly one {tenant, user, source, device}. It is
 * meant to be redeemed once; `consumedAt` records when it was.
 *
 * IMPORTANT: this TYPE does not enforce single-use. The enforcement is Azure
 * atomically setting `consumedAt` and refusing a second redemption, in a later
 * phase. The type only gives that mechanism a shape to write into.
 */
export interface PairingNonceRecord {
  /** Opaque random value. Never encodes tenant/user/source or any customer data. */
  nonce: string;
  tenantId: string;
  userId: string;
  sourceId: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  /** Set when the nonce is redeemed. Null while still unused. */
  consumedAt: string | null;
}

// ===========================================================================
// §5  Session token (contract only — opaque, scoped; non-replay enforced later)
// ===========================================================================

export const GATEWAY_SESSION_TTL_SECONDS = 900 as const;

export const GATEWAY_SESSION_STATUSES = ['active', 'expired', 'revoked'] as const;
export type GatewaySessionStatus = (typeof GATEWAY_SESSION_STATUSES)[number];

/**
 * A browser↔agent session, scoped to a single pairing. The `token` is an OPAQUE
 * random string — customer information is NEVER encoded into it (no Aadhaar, PAN,
 * name, email, or any value). It is:
 *   - tenant-scoped, user-scoped, source-scoped, device-scoped,
 *   - short-lived (GATEWAY_SESSION_TTL_SECONDS),
 *   - revocable (status → 'revoked'),
 *   - tied to exactly one pairing (pairingNonce),
 * and, in the enforcing phases: never persisted to disk, never in localStorage,
 * never in a cookie set by the agent, never in logs.
 *
 * This type gives those rules a home; it does not implement them. Non-replay,
 * revocation checks, and expiry checks are done by Azure + the agent later.
 */
export interface GatewaySession {
  /** Opaque random token. No customer data, ever. */
  token: string;
  tenantId: string;
  userId: string;
  sourceId: string;
  deviceId: string;
  /** The single pairing nonce this session was established from. */
  pairingNonce: string;
  issuedAt: string;
  expiresAt: string;
  status: GatewaySessionStatus;
}

// ===========================================================================
// §6  Control-plane API contract (Agent → Azure). RECOMMENDED ROUTE NAMES ONLY.
// ===========================================================================
//
// These are the eventual control-plane operations. They are enumerated as
// string constants — NOT Nest routes. Phase 3A creates NO endpoints; a later
// phase implements a subset behind the existing API conventions (TenantGuard /
// @Roles / @Audited). Auth/authz/TTL/replay/binding are documented per op.

export const GATEWAY_CONTROL_ROUTES = {
  /** Device redeems a one-time enrollment code → receives its device binding.
   *  Auth: enrollment code (short-lived, single-use). Binds: tenant + device. */
  enroll: '/gateway/enroll',
  /** Agent checks in: liveness, version, config pull. Auth: device credential.
   *  Binds: device (→ its tenant). Replay: heartbeats are idempotent. */
  heartbeat: '/gateway/heartbeat',
  /** Agent redeems a pairing nonce presented by the browser. Auth: device
   *  credential. Binds: nonce ↔ {tenant,user,source,device}. Replay: nonce is
   *  single-use (enforced by Azure, later). TTL: GATEWAY_PAIRING_NONCE_TTL. */
  pairRedeem: '/gateway/pair/redeem',
  /** Agent refreshes a session before expiry. Auth: device credential + active
   *  session. Binds: session. TTL: GATEWAY_SESSION_TTL. */
  sessionRefresh: '/gateway/session/refresh',
  /** Agent de-enrolls itself (clean uninstall). Auth: device credential. */
  deenroll: '/gateway/deenroll',
  /** Staff revoke a device from the platform. Auth: @Roles(MANAGE). Binds:
   *  device. Effect: Azure stops issuing sessions; agent shuts its listener. */
  revoke: '/gateway/revoke',
} as const;
export type GatewayControlRoute =
  (typeof GATEWAY_CONTROL_ROUTES)[keyof typeof GATEWAY_CONTROL_ROUTES];

/** Enrollment: request carries the code + the device's public identity. */
export interface GatewayEnrollRequest {
  enrollmentCode: string;
  device: DeviceEnrollmentRequest;
}
export interface GatewayEnrollResponse {
  device: DeviceIdentity;
}

/** Heartbeat: liveness + version + which sources this device is bound to. */
export interface GatewayHeartbeatRequest {
  deviceId: string;
  agentVersion: string;
}
export interface GatewayHeartbeatResponse {
  deviceStatus: GatewayDeviceStatus;
  /** Source ids this device is currently permitted to serve (metadata only). */
  boundSourceIds: string[];
  /** If Azure wants the agent to update before continuing. */
  minSupportedVersion: string;
}

/** Pairing redemption: the agent presents the nonce it got from the browser. */
export interface GatewayPairRedeemRequest {
  deviceId: string;
  nonce: string;
}
export interface GatewayPairRedeemResponse {
  session: GatewaySession;
}

export interface GatewaySessionRefreshRequest {
  deviceId: string;
  token: string;
}
export interface GatewaySessionRefreshResponse {
  session: GatewaySession;
}

export interface GatewayDeenrollRequest {
  deviceId: string;
}
export interface GatewayRevokeRequest {
  deviceId: string;
  /** WHY — recorded as audit metadata (I4). Never a customer value. */
  reason: string;
}

// ===========================================================================
// §7  Data-plane API contract (Browser → Agent). SCHEMAS ONLY — no endpoints.
// ===========================================================================
//
// Bounded, paginated, cancelable, source-scoped, session-scoped. There is NO
// unrestricted "read everything" shape anywhere: no allData, no dump, no rows-
// without-bounds. The read/search requests require a sourceId + session and
// carry NO raw filesystem path, NO raw SQL, NO table name as a trusted
// identifier, and NO credential — the browser never names a resource directly;
// it can only reference an OPAQUE ResourceHandle that discover()/search() already
// returned, and the Gateway resolves that handle INTERNALLY to an authorized
// file/table/query. This is what makes the contract genuinely source-agnostic:
// a file and a database table are both just opaque handles to the browser.

export const GATEWAY_DATA_ROUTES = {
  health: '/health',
  sessionEstablish: '/session/establish',
  sourceDiscover: '/source/discover',
  sourceSearch: '/source/search',
  sourceRead: '/source/read',
  sourceMetadata: '/source/metadata',
  /** Phase 3G-1: list the FIELDS (columns/headers) of one resource — structure
   *  only, same class as discover()/metadata(), never a row. This is what lets
   *  the Consent Form Builder show "which existing columns can I map to?"
   *  without ever reading a customer value. */
  sourceFields: '/source/fields',
  /**
   * Phase 3G-2: customer resolution + controlled write/create + controlled
   * column creation. Every one of these is a STRUCTURED operation — never
   * arbitrary SQL, never a browser-supplied path/table/column the Gateway
   * "just trusts". The Gateway re-validates identity-column config, the
   * writable-column allowlist, and (for column creation) a strict identifier +
   * type allowlist, on every call. See the DataConnector methods below.
   */
  customerResolve: '/source/customer/resolve',
  customerWrite: '/source/customer/write',
  customerCreate: '/source/customer/create',
  columnCreate: '/source/column/create',
} as const;
export type GatewayDataRoute =
  (typeof GATEWAY_DATA_ROUTES)[keyof typeof GATEWAY_DATA_ROUTES];

/** Default + hard-cap page size for any bounded read. The agent enforces these. */
export const GATEWAY_READ_DEFAULT_LIMIT = 100 as const;
export const GATEWAY_READ_MAX_LIMIT = 1000 as const;

/** Liveness only — no auth, no data, no source context. */
export interface GatewayHealthResponse {
  status: 'ok';
  agentVersion: string;
}

/**
 * The browser hands the agent the pairing nonce (obtained from Azure over the
 * app session) to establish a local session. The agent redeems it via its own
 * outbound control channel (§6) before returning success — so a forged nonce
 * cannot establish a session.
 */
export interface GatewaySessionEstablishRequest {
  sourceId: string;
  nonce: string;
}
export interface GatewaySessionEstablishResponse {
  /** Opaque session token to present (in GATEWAY_AUTH_HEADER) on later calls. */
  sessionToken: string;
  expiresAt: string;
}

/**
 * The kind of resource a handle points at. Source-agnostic on purpose: a file
 * source yields 'file' handles, a database yields 'table' (or a saved 'query')
 * handles — and the browser treats all of them identically, as opaque handles.
 */
export const RESOURCE_KINDS = ['file', 'table', 'query'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * A NON-SENSITIVE descriptor of a resource, purely so the UI can render a list.
 * It carries a display label the GATEWAY chose (e.g. 'customers.xlsx' or
 * 'public.customers') — NOT a filesystem path, NOT raw SQL, NOT a credential, and
 * NOT a value. The label is for display only; it is never a trusted identifier
 * the browser can send back to name a resource (only the opaque handle is).
 */
export interface ResourceDescriptor {
  resourceKind: ResourceKind;
  /** Display label chosen by the Gateway. Never a path/SQL/credential/value. */
  label: string;
  /** Approx size for files; null where size is not meaningful (e.g. a table). */
  sizeBytes: number | null;
  /** Approx row count where known (files/tables); null otherwise. */
  estimatedRowCount: number | null;
}

/**
 * A source-agnostic, OPAQUE resource handle — the generalization of the former
 * file-specific handle. The `handle` is the ONLY thing the browser ever sends to
 * name a resource; it is meaningless to the browser and the Gateway resolves it
 * INTERNALLY to an authorized file/table/query. This type deliberately has NO
 * field for a filesystem path, raw SQL, a table name, a connection string, or a
 * credential — those must never travel from the browser, so they are not here.
 */
export interface ResourceHandle {
  /** Opaque, Gateway-issued. Resolved server-side to an authorized resource. */
  handle: string;
  descriptor: ResourceDescriptor;
}

export interface GatewaySourceDiscoverRequest {
  sourceId: string;
}
export interface GatewaySourceDiscoverResponse {
  sourceId: string;
  /** What this source can do — capability metadata, never data. */
  capabilities: GatewayConnectorCapability[];
  /** Bounded set of OPAQUE resource handles the caller is authorized to see —
   *  files under allowed roots, or authorized database tables. Source-agnostic. */
  handles: ResourceHandle[];
  /** True when the result was capped (there were more). */
  truncated: boolean;
}

export interface GatewaySourceSearchRequest {
  sourceId: string;
  /** A search term over resource METADATA (labels/handles) the caller is
   *  authorized for. NOT a path, glob, raw SQL, or arbitrary query — the Gateway
   *  matches it only against resources already within the authorized set. */
  term: string;
  limit?: number;
  cursor?: string;
}
export interface GatewaySourceSearchResponse {
  handles: ResourceHandle[];
  nextCursor: string | null;
  truncated: boolean;
}

/**
 * A bounded, cancelable read of one already-discovered handle. `requestId` lets
 * the browser cancel an in-flight read (agent stops working). There is NO field
 * for a path, raw SQL, or a table name — reads are by OPAQUE handle only, and the
 * handle came from discover/search, which only ever enumerate the authorized set.
 * The Gateway resolves the handle to the concrete file/table/query internally.
 */
export interface GatewaySourceReadRequest {
  sourceId: string;
  handle: string;
  /** Client-generated id, for cancellation + correlation. */
  requestId: string;
  limit?: number;
  cursor?: string;
}
export interface GatewaySourceReadResponse {
  /** Column headers for display. */
  headers: string[];
  /** A bounded batch of rows. These are RAW VALUES — they exist ONLY on the
   *  data plane (agent memory → browser memory), NEVER on the control plane,
   *  NEVER sent to Azure, NEVER persisted. This response type is DATA-PLANE
   *  ONLY, which is exactly why it lives on the browser↔agent contract and why
   *  no Azure control DTO above carries anything like it. */
  rows: string[][];
  nextCursor: string | null;
  truncated: boolean;
}

export interface GatewaySourceMetadataRequest {
  sourceId: string;
  handle: string;
}
export interface GatewaySourceMetadataResponse {
  /** Resource kind + size/row estimate — never content. Size is null where it is
   *  not meaningful (e.g. a database table). Source-agnostic, like ResourceHandle. */
  resourceKind: ResourceKind;
  sizeBytes: number | null;
  estimatedRowCount: number | null;
}

/**
 * One field (column/header) of a resource — STRUCTURE ONLY, never a value.
 * `type` is a best-effort, connector-reported label (e.g. 'text', 'integer',
 * 'timestamp') — this is NOT a schema-inference engine; it is whatever the
 * source itself reports (information_schema for databases, "always text" for a
 * CSV/XLSX header). Nothing here carries business meaning (no "this looks like
 * an Aadhaar column") — that judgement is made by a human in the Consent Form
 * Builder, explicitly, never inferred by the platform.
 */
export interface FieldDescriptor {
  name: string;
  type: string;
  nullable: boolean;
}

export interface GatewaySourceFieldsRequest {
  sourceId: string;
  handle: string;
}
export interface GatewaySourceFieldsResponse {
  fields: FieldDescriptor[];
}

// ===========================================================================
// Phase 3G-2 — customer resolution, controlled write/create, controlled
// column creation. Every shape below carries EITHER metadata (a column NAME,
// an opaque ref) OR exactly one bounded set of caller-supplied VALUES destined
// only for the data plane (never a control-plane/central request). None of
// these types is ever sent to Azure — see gateway.controller.ts (backend),
// which only ever receives a post-hoc {action, rowCount} audit fact.
// ===========================================================================

/**
 * Resolve a customer by the source's configured identity column. The browser
 * supplies ONLY the value to match — never the column name (the Gateway uses
 * its own configured identity column; the browser cannot choose one).
 */
export interface GatewayResolveCustomerRequest {
  sourceId: string;
  handle: string;
  identityValue: string;
}
export interface GatewayResolveCustomerResponse {
  exists: boolean;
  /** Opaque, Gateway-issued. Never the database primary key, never a value. */
  customerRef: string | null;
}

/**
 * Update an EXISTING customer's explicitly-mapped fields. `fields` is a flat
 * {columnName: value} map; the Gateway accepts a key ONLY if that column is in
 * its own configured writable-column allowlist for this source — an arbitrary
 * column name is rejected (COLUMN_NOT_MAPPED), never "just updated".
 */
export interface GatewayWriteCustomerFieldsRequest {
  sourceId: string;
  handle: string;
  customerRef: string;
  fields: Record<string, string>;
}
export interface GatewayWriteCustomerFieldsResponse {
  success: true;
}

/**
 * Create a customer ONLY when the source explicitly allows it. Same
 * writable-column enforcement as write; if the identity already exists, this
 * returns the EXISTING reference rather than creating a duplicate.
 */
export interface GatewayCreateCustomerRequest {
  sourceId: string;
  handle: string;
  identityValue: string;
  fields: Record<string, string>;
}
export interface GatewayCreateCustomerResponse {
  created: boolean;
  exists: boolean;
  customerRef: string | null;
}

/** The only column types "create new column" may request — a small, explicit
 *  allowlist, never an arbitrary SQL type string. */
export const NEW_CUSTOMER_COLUMN_TYPES = ['text', 'integer', 'boolean', 'date', 'datetime'] as const;
export type NewCustomerColumnType = (typeof NEW_CUSTOMER_COLUMN_TYPES)[number];

/**
 * The CONTROLLED "create new column" operation (what Phase 3G-1 only recorded
 * as a request). A structured operation — not arbitrary SQL — gated on a
 * separate, optional, privileged write credential; absent that credential this
 * fails closed (WRITE_NOT_CONFIGURED). Unsupported for file sources.
 */
export interface GatewayCreateColumnRequest {
  sourceId: string;
  handle: string;
  columnName: string;
  columnType: NewCustomerColumnType;
}
export interface GatewayCreateColumnResponse {
  created: true;
}

// ===========================================================================
// §8  Connector interface (agent-side). SEPARATE from SchemaSource (S4).
// ===========================================================================
//
// SchemaSource (S4, seams.ts) is metadata-only FOREVER and has no readRows().
// The Gateway connector is a DIFFERENT capability: it may read bounded raw rows,
// but only on the data plane, in agent memory, for an authorized session. It is
// intentionally its own interface and does not extend or import SchemaSource.

export const GATEWAY_CONNECTOR_CAPABILITIES = [
  'discover',
  'search',
  'read',
  'metadata',
  'listFields',
  'healthCheck',
  // Phase 3G-2 — structured, always-enforced-at-call-time. A connector
  // advertising these still fails closed per-call (unconfigured identity
  // column, unmapped column, disabled creation, missing write credential).
  'resolveCustomer',
  'writeCustomerFields',
  'createCustomer',
  'createColumn',
] as const;
export type GatewayConnectorCapability =
  (typeof GATEWAY_CONNECTOR_CAPABILITIES)[number];

/** Options every read/search carries: bounded, cancelable, time-limited. */
export interface GatewayReadOptions {
  limit?: number;
  cursor?: string;
  /** Cooperative cancellation token id — the caller can ask the agent to stop. */
  requestId?: string;
  /** Hard timeout in ms; the connector aborts past this. */
  timeoutMs?: number;
}

/**
 * DataConnector — the agent-side connector contract (Phase 3A: interface only,
 * NO implementation). Filesystem/Excel/CSV connectors implement this against the
 * allowed-roots model in a later phase; DB connectors implement the same shape
 * against a read-only credential much later. It has healthCheck for liveness,
 * bounded reads, cursors, cancellation and a connector-specific error.
 *
 *   ✗ There is NO implementation of this interface in Phase 3A.
 *   ✗ It is NOT SchemaSource, and must never be merged into it.
 */
export interface DataConnector {
  readonly sourceKind: DataSourceKind;
  discover(): Promise<GatewaySourceDiscoverResponse>;
  search(term: string, opts?: GatewayReadOptions): Promise<GatewaySourceSearchResponse>;
  read(handle: string, opts?: GatewayReadOptions): Promise<GatewaySourceReadResponse>;
  metadata(handle: string): Promise<GatewaySourceMetadataResponse>;
  /** Phase 3G-1: the fields (columns/headers) of one resource — structure only,
   *  never a row. Backs the Consent Form Builder's "map to an existing column"
   *  picker. */
  listFields(handle: string): Promise<GatewaySourceFieldsResponse>;
  /**
   * Phase 3G-2: resolve an existing customer by the connector's OWN configured
   * identity column. Returns an opaque ref — never the row, never the primary
   * key. Fails closed (IDENTITY_NOT_CONFIGURED) if no identity column is set.
   */
  resolveCustomer(handle: string, identityValue: string): Promise<GatewayResolveCustomerResponse>;
  /**
   * Phase 3G-2: update an existing customer's EXPLICITLY MAPPED fields only.
   * Any key not in the connector's writable-column allowlist is rejected
   * (COLUMN_NOT_MAPPED) — the browser cannot make an arbitrary column writable
   * by simply naming it. Requires a privileged write credential to be
   * configured; fails closed (WRITE_NOT_CONFIGURED) otherwise.
   */
  writeCustomerFields(customerRef: string, fields: Record<string, string>): Promise<GatewayWriteCustomerFieldsResponse>;
  /**
   * Phase 3G-2: create a customer ONLY when explicitly allowed for this
   * source (CUSTOMER_CREATION_DISABLED otherwise). Same writable-column
   * enforcement as writeCustomerFields; never creates a duplicate — an
   * existing identity match is returned instead of inserting a new row.
   */
  createCustomer(handle: string, identityValue: string, fields: Record<string, string>): Promise<GatewayCreateCustomerResponse>;
  /**
   * Phase 3G-2: the CONTROLLED "create new column" operation — a structured
   * ALTER, never arbitrary SQL. Strict identifier validation, a small type
   * allowlist (NEW_CUSTOMER_COLUMN_TYPES), and the separate privileged write
   * credential are all enforced here, every call. Unsupported for file sources
   * (UNSUPPORTED_SOURCE) — a CSV/XLSX column must be added externally.
   */
  createColumn(handle: string, columnName: string, columnType: NewCustomerColumnType): Promise<GatewayCreateColumnResponse>;
  healthCheck(): Promise<GatewayHealthResponse>;
}

// ===========================================================================
// §9  Filesystem security contract (contract only — containment enforced later)
// ===========================================================================
//
// The browser must NEVER hand the agent an arbitrary path to open. A source is
// configured with an ALLOWLIST of roots; the agent only ever touches paths that
// (a) resolve — after canonicalisation and symlink/junction resolution — to a
// strict descendant of an allowed root, and (b) match the file-type allowlist.
// The pipeline below is the CONTRACT the agent's resolver must satisfy; this
// file does not perform any resolution or open any file.

export const GATEWAY_ROOT_KINDS = ['local_path', 'unc'] as const;
export type GatewayRootKind = (typeof GATEWAY_ROOT_KINDS)[number];

/** Only these file types may be surfaced or read (this phase's scope). */
export const GATEWAY_FILE_TYPE_ALLOWLIST = ['.csv', '.xlsx'] as const;
export type GatewayAllowedFileType = (typeof GATEWAY_FILE_TYPE_ALLOWLIST)[number];

/** One allowed root, configured by an admin and stored in Azure metadata (so it
 *  is auditable/centrally reviewable), enforced by the agent. `unc` roots are a
 *  distinct, higher-risk kind requiring explicit opt-in. */
export interface GatewayAllowedRoot {
  sourceId: string;
  rootKind: GatewayRootKind;
  /** The configured root, e.g. 'D:\\Customers\\'. NOT a file — a boundary. */
  rootPath: string;
}

/** The steps the agent's resolver MUST perform, in order, before any read. This
 *  is documentation-as-contract; the guard test asserts every step is named. */
export const GATEWAY_PATH_RESOLUTION_STEPS = [
  'canonicalize',
  'resolve_symlinks_and_junctions',
  'verify_descendant_of_allowed_root',
  'verify_extension_allowlist',
] as const;
export type GatewayPathResolutionStep =
  (typeof GATEWAY_PATH_RESOLUTION_STEPS)[number];

/** The threats the resolver must defeat (named so review can check coverage). */
export const GATEWAY_PATH_THREATS = [
  'dot_dot_traversal',
  'absolute_path_injection',
  'symlink',
  'junction',
  'unc_path',
  'hidden_file',
  'system_file',
  'executable_file',
  'path_encoding_trick',
  'case_sensitivity',
] as const;
export type GatewayPathThreat = (typeof GATEWAY_PATH_THREATS)[number];

/** The outcome shape a resolver returns. `allowed:false` carries a reason CODE
 *  (never the offending path/value — see the error model). */
export interface GatewayPathResolutionResult {
  allowed: boolean;
  /** Present only when allowed:false. A code, not a path or value. */
  deniedReason?: GatewayErrorCode;
}

// ===========================================================================
// §10  Error model — codes only; never carry a raw value or a sensitive path
// ===========================================================================

export const GATEWAY_ERROR_CODES = [
  'AGENT_NOT_ENROLLED',
  'AGENT_REVOKED',
  'SESSION_EXPIRED',
  'INVALID_ORIGIN',
  'INVALID_TOKEN',
  'INVALID_NONCE',
  'TENANT_MISMATCH',
  'SOURCE_MISMATCH',
  'DEVICE_MISMATCH',
  'SOURCE_NOT_AUTHORIZED',
  'PATH_NOT_ALLOWED',
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'UNSUPPORTED_SOURCE',
  'RATE_LIMITED',
  'TIMEOUT',
  // Phase 3G-2: customer resolution/write/create + controlled column creation.
  /** No privileged write credential is configured for this source — writes,
   *  customer creation, and column creation all fail closed with this code. */
  'WRITE_NOT_CONFIGURED',
  /** The caller named a column that is not in this source's explicit writable-
   *  column allowlist (or it sent no fields at all). Never "the column doesn't
   *  exist" — that distinction is not leaked. */
  'COLUMN_NOT_MAPPED',
  /** An opaque customerRef does not resolve to a known, still-authorized row. */
  'CUSTOMER_NOT_FOUND',
  /** Customer creation was attempted but this source does not allow it. */
  'CUSTOMER_CREATION_DISABLED',
  /** "Create new column" was attempted for a column name that already exists. */
  'COLUMN_ALREADY_EXISTS',
  /** No identity column is configured for this source — resolution/creation
   *  cannot run without one. */
  'IDENTITY_NOT_CONFIGURED',
  /** A caller-supplied identifier (column name) failed strict validation. */
  'INVALID_IDENTIFIER',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** A safe Gateway error: a code + a generic, value-free message. It has NO field
 *  for a path, a filename, a row, a cell, or any customer value — by design. */
export interface GatewayError {
  code: GatewayErrorCode;
  /** A generic, human-readable message. MUST NOT contain a customer value or a
   *  sensitive filename/path. Enforcement is the sender's; this is the shape. */
  message: string;
}

// ===========================================================================
// §11  Audit contract — METADATA ONLY (does not change the S5 implementation)
// ===========================================================================
//
// The eventual Gateway audit action names, and the exact metadata an entry may
// carry. This defines the CONTRACT; it does not modify the S5 interceptor, the
// sink, or the hash chain (that stays exactly as it is). When the Gateway is
// built, its control-plane operations are @Audited with these names and annotate
// with this metadata shape — the same discipline as datasource.raw_access.viewed.

export const GATEWAY_AUDIT_ACTIONS = [
  'gateway.session.created',
  'gateway.session.closed',
  'gateway.source.discovered',
  'gateway.source.searched',
  'gateway.raw_access.viewed',
  'gateway.raw_access.failed',
  // Phase 3G-2: customer resolution/write/create + controlled column creation.
  // Recorded by the CENTRAL backend as a post-hoc, metadata-only fact — the
  // Gateway operation itself already completed entirely within the client
  // environment; these actions never carry an identity value or a field value.
  'gateway.customer.resolved',
  'gateway.customer.updated',
  'gateway.customer.created',
  'gateway.customer.write_failed',
  'gateway.column.created',
] as const;
export type GatewayAuditAction = (typeof GATEWAY_AUDIT_ACTIONS)[number];

/**
 * The ONLY fields a Gateway audit entry may carry. Every field here is metadata:
 * ids, an operation name, timing, a status, and an optional COUNT. There is
 * deliberately NO field for a customer name, Aadhaar, PAN, phone, email, address,
 * a row, a cell, a file's contents, a query result, or a sensitive filename.
 *
 * (rowCount is a count, in the same safe class as Tier-2's relay byte-count. In
 * rare contexts a count can be weakly informative — that residual is an
 * organisational access-policy matter, noted as an open question, not something
 * this shape can or should encode away.)
 */
export interface GatewayAuditMetadata {
  tenantId: string;
  userId: string;
  sourceId: string;
  deviceId: string;
  operation: GatewayAuditAction;
  timestamp: string;
  durationMs: number;
  status: 'success' | 'denied' | 'error';
  rowCount?: number;
}

// ===========================================================================
// §12  Agent log allowlist — the ONLY fields the agent may log
// ===========================================================================
//
// The future agent's own local logs use an ALLOWLISTED metadata schema. These
// are the only field names permitted. Everything else — above all customer
// values and sensitive file/directory NAMES — is forbidden. (A filename such as
// 'Divorce_Settlement_Priya.xlsx' leaks even if the file is never opened, which
// is why the agent references files by opaque handle, not by name — see §7.)

export const GATEWAY_LOG_FIELDS = [
  'sourceId',
  'deviceId',
  'operation',
  'timestamp',
  'durationMs',
  'status',
  'rowCount',
  'errorCategory',
  'fileHandle',
] as const;
export type GatewayLogField = (typeof GATEWAY_LOG_FIELDS)[number];
