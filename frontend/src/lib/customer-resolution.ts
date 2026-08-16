/**
 * Phase 3H-1 — the common CUSTOMER RESOLUTION abstraction.
 *
 * One small dispatch layer over the two connected-source mechanisms that
 * already exist, so a DPDP feature (Consent first; Grievance/DSR/Breach later)
 * can ask "does this customer exist in the connected source, and can I write
 * these mapped fields" WITHOUT knowing which mechanism backs the source, and
 * WITHOUT the identity value or any field value ever reaching the central
 * NestJS backend.
 *
 *   Enterprise SQL (postgresql/mysql/sqlserver):
 *     this browser → (pair + establish, reusing the existing 3G control plane)
 *     → an existing Gateway data-plane session → the existing 3G-2 structured
 *     customer operations (resolveCustomer/writeCustomerFields/createCustomer).
 *     No SQL is built here — every operation is the SAME opaque, structured
 *     call the Gateway browser page (data-sources/[id]/gateway/page.tsx) and
 *     the agent's DatabaseConnector already implement and enforce.
 *
 *   SaaS local Excel/CSV (excel/csv):
 *     this browser → the already-persisted FileSystemFileHandle
 *     (local-source-handles.ts) → the existing local parser (local-file.ts).
 *     Read-only: resolveCustomer searches the already-open file in memory.
 *     writeCustomerFields/createCustomer always return UNSUPPORTED_SOURCE —
 *     there is no write-back path to a local file, and this module must never
 *     invent one (matches agent/src/connectors/filesystem-connector.ts, which
 *     refuses the same operations for exactly the same reason).
 *
 * Every function throws CustomerResolutionError on failure — never a partial
 * result, never a guess. Nothing here ever calls apiFetch with an identity
 * value, a field value, or a customer reference; the only backend calls made
 * (GET /gateway/devices/active, POST /gateway/pairings) are the existing
 * control-plane metadata routes the Gateway browser page already uses.
 */
import {
  GATEWAY_AUTH_HEADER,
  type DataSource,
  type FieldDescriptor,
  type GatewayErrorCode,
  type ResourceHandle,
} from '@dpdp/shared';
import { apiFetch, ApiError } from './api';
import { getHandle, queryHandlePermission } from './local-source-handles';
import { parseLocalFile, LocalFileError } from './local-file';

export type CustomerResolutionErrorCode = GatewayErrorCode | 'NOT_CONNECTED';

/** A sanitized, value-free error — mirrors ConnectorError/GatewayError's own
 *  discipline: a stable code + a generic message, never a customer value. */
export class CustomerResolutionError extends Error {
  constructor(
    public readonly code: CustomerResolutionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CustomerResolutionError';
  }
}

export interface ResolveCustomerResult {
  exists: boolean;
  /** Opaque. For Gateway sources, the Gateway's own customerRef. For a local
   *  file, an in-memory-only pointer meaningful solely within this module —
   *  never a database key, never sent anywhere. */
  customerRef: string | null;
}
export interface WriteCustomerFieldsResult {
  success: true;
}
export interface CreateCustomerResult {
  created: boolean;
  exists: boolean;
  customerRef: string | null;
}

const LOCAL_FILE_KINDS = new Set<DataSource['sourceKind']>(['excel', 'csv']);
const GATEWAY_SQL_KINDS = new Set<DataSource['sourceKind']>(['postgresql', 'mysql', 'sqlserver']);

function assertGatewayConnected(source: DataSource): void {
  if (source.status !== 'active' || source.dataAccessMode !== 'gateway_connected') {
    throw new CustomerResolutionError('SOURCE_NOT_AUTHORIZED', 'This source is not Gateway-connected.');
  }
}

// ===========================================================================
// Public dispatch
// ===========================================================================

export async function resolveCustomer(source: DataSource, identityValue: string): Promise<ResolveCustomerResult> {
  if (LOCAL_FILE_KINDS.has(source.sourceKind)) return resolveCustomerLocal(source, identityValue);
  if (GATEWAY_SQL_KINDS.has(source.sourceKind)) return resolveCustomerGateway(source, identityValue);
  throw new CustomerResolutionError('UNSUPPORTED_SOURCE', `Customer resolution is not supported for "${source.sourceKind}" sources.`);
}

export async function writeCustomerFields(
  source: DataSource,
  customerRef: string,
  fields: Record<string, string>,
): Promise<WriteCustomerFieldsResult> {
  if (LOCAL_FILE_KINDS.has(source.sourceKind)) {
    throw new CustomerResolutionError(
      'UNSUPPORTED_SOURCE',
      'Customer data updates are not supported for local Excel/CSV sources yet. The connected file is currently read-only.',
    );
  }
  if (GATEWAY_SQL_KINDS.has(source.sourceKind)) return writeCustomerFieldsGateway(source, customerRef, fields);
  throw new CustomerResolutionError('UNSUPPORTED_SOURCE', `Customer field writes are not supported for "${source.sourceKind}" sources.`);
}

export async function createCustomer(
  source: DataSource,
  identityValue: string,
  fields: Record<string, string>,
): Promise<CreateCustomerResult> {
  if (LOCAL_FILE_KINDS.has(source.sourceKind)) {
    throw new CustomerResolutionError(
      'UNSUPPORTED_SOURCE',
      'Creating a customer is not supported for local Excel/CSV sources yet. The connected file is currently read-only.',
    );
  }
  if (GATEWAY_SQL_KINDS.has(source.sourceKind)) return createCustomerGateway(source, identityValue, fields);
  throw new CustomerResolutionError('UNSUPPORTED_SOURCE', `Customer creation is not supported for "${source.sourceKind}" sources.`);
}

// ===========================================================================
// SaaS local Excel/CSV — read-only, entirely in this browser
// ===========================================================================

async function resolveCustomerLocal(source: DataSource, identityValue: string): Promise<ResolveCustomerResult> {
  if (!source.identityColumn) {
    throw new CustomerResolutionError('IDENTITY_NOT_CONFIGURED', 'No identity column is configured for this source.');
  }
  const record = await getHandle(source.id);
  if (!record) {
    throw new CustomerResolutionError('NOT_CONNECTED', 'This local file is not connected in this browser. Open its Data Viewer to connect it first.');
  }
  const permission = await queryHandlePermission(record.handle);
  if (permission !== 'granted') {
    throw new CustomerResolutionError('NOT_CONNECTED', 'This local file needs to be reconnected. Open its Data Viewer to reconnect.');
  }
  let file: File;
  try {
    file = await record.handle.getFile();
  } catch {
    throw new CustomerResolutionError('FILE_NOT_FOUND', 'The connected local file could not be accessed. It may have been moved, renamed, or deleted.');
  }
  let parsed: Awaited<ReturnType<typeof parseLocalFile>>;
  try {
    parsed = await parseLocalFile(file);
  } catch (err) {
    throw new CustomerResolutionError('PERMISSION_DENIED', err instanceof LocalFileError ? err.message : 'Could not read the connected local file.');
  }
  const columnIndex = parsed.headers.indexOf(source.identityColumn);
  if (columnIndex === -1) {
    throw new CustomerResolutionError('IDENTITY_NOT_CONFIGURED', `Column "${source.identityColumn}" was not found in the connected file.`);
  }
  const needle = identityValue.trim().toLowerCase();
  const rowIndex = parsed.rows.findIndex((row) => (row[columnIndex] ?? '').trim().toLowerCase() === needle);
  if (rowIndex === -1) return { exists: false, customerRef: null };
  return { exists: true, customerRef: `local:${rowIndex}` };
}

// ===========================================================================
// Enterprise SQL — browser → existing Gateway session → existing 3G-2 ops
// ===========================================================================

interface ActiveGatewaySession {
  sourceId: string;
  agentUrl: string;
  sessionToken: string;
  resourceHandle: string;
  expiresAt: number;
}

/** In-memory only — never persisted, never survives a page reload. Re-derived
 *  (pair + establish) whenever missing or close to expiry. */
let cachedSession: ActiveGatewaySession | null = null;

async function gatewayFetch(agentUrl: string, sessionToken: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const base = agentUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GATEWAY_AUTH_HEADER]: sessionToken },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    const code = (j.error as CustomerResolutionErrorCode | undefined) ?? 'TIMEOUT';
    throw new CustomerResolutionError(code, `The Gateway refused this request (${code}).`);
  }
  return res.json();
}

/**
 * Establish (or reuse) a Gateway data-plane session for this source, exactly
 * the way the existing Gateway browser page does — GET the persisted active
 * device (3G-2.5), POST a pairing (existing 3C control plane), then POST
 * /session/establish directly to the agent (existing 3D data plane). Then
 * discover() the source's single resource.
 *
 * LIMITATION (documented, not silently guessed around): if the Gateway
 * connection exposes more than one table-shaped resource, this throws
 * SOURCE_NOT_AUTHORIZED rather than picking one — there is no central,
 * durable reference today for "which table" a data source's identity/
 * writable-column configuration applies to (see the discovery report). A
 * source with exactly one visible table works automatically.
 */
async function establishGatewaySession(source: DataSource): Promise<ActiveGatewaySession> {
  assertGatewayConnected(source);
  if (cachedSession && cachedSession.sourceId === source.id && cachedSession.expiresAt > Date.now() + 5000) {
    return cachedSession;
  }

  let device: { id: string; endpoint: string | null; status: string } | null;
  try {
    const res = await apiFetch<{ device: { id: string; endpoint: string | null; status: string } | null }>('/gateway/devices/active');
    device = res.device;
  } catch (err) {
    throw new CustomerResolutionError('AGENT_NOT_ENROLLED', err instanceof ApiError ? err.message : 'Could not reach the Gateway configuration.');
  }
  if (!device || device.status !== 'active') {
    throw new CustomerResolutionError('AGENT_NOT_ENROLLED', 'No active Enterprise Gateway is connected for this tenant.');
  }
  if (!device.endpoint) {
    throw new CustomerResolutionError('NOT_CONNECTED', 'The Enterprise Gateway has no configured endpoint yet.');
  }

  let pairing: { nonce: string };
  try {
    pairing = await apiFetch<{ nonce: string; expiresAt: string }>('/gateway/pairings', {
      method: 'POST',
      body: { sourceId: source.id, deviceId: device.id },
    });
  } catch (err) {
    throw new CustomerResolutionError('SOURCE_NOT_AUTHORIZED', err instanceof ApiError ? err.message : 'Could not create a Gateway pairing for this source.');
  }

  const agentUrl = device.endpoint.replace(/\/+$/, '');
  const establishRes = await fetch(`${agentUrl}/session/establish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: source.id, nonce: pairing.nonce }),
  }).catch(() => null);
  if (!establishRes || !establishRes.ok) {
    throw new CustomerResolutionError('TIMEOUT', 'Could not establish a session with the Enterprise Gateway. Is it running and reachable?');
  }
  const established = (await establishRes.json()) as { sessionToken: string; expiresAt: string };

  const discovered = (await gatewayFetch(agentUrl, established.sessionToken, '/source/discover', { sourceId: source.id })) as {
    handles: ResourceHandle[];
  };
  const tables = discovered.handles.filter((h) => h.descriptor.resourceKind === 'table');
  if (tables.length === 0) {
    throw new CustomerResolutionError('SOURCE_NOT_AUTHORIZED', 'No table is visible through this Gateway connection.');
  }
  if (tables.length > 1) {
    throw new CustomerResolutionError(
      'SOURCE_NOT_AUTHORIZED',
      'This Gateway connection exposes more than one table; customer resolution needs a connection scoped to a single customer table.',
    );
  }

  cachedSession = {
    sourceId: source.id,
    agentUrl,
    sessionToken: established.sessionToken,
    resourceHandle: tables[0]!.handle,
    expiresAt: Date.parse(established.expiresAt),
  };
  return cachedSession;
}

/** Runs `fn` with a valid session; on a session-shaped failure, clears the
 *  cache and retries exactly once with a freshly established session. */
async function withGatewaySession<T>(source: DataSource, fn: (s: ActiveGatewaySession) => Promise<T>): Promise<T> {
  const session = await establishGatewaySession(source);
  try {
    return await fn(session);
  } catch (err) {
    const retryable = err instanceof CustomerResolutionError && (err.code === 'SESSION_EXPIRED' || err.code === 'INVALID_TOKEN');
    if (!retryable) throw err;
    cachedSession = null;
    const fresh = await establishGatewaySession(source);
    return fn(fresh);
  }
}

async function resolveCustomerGateway(source: DataSource, identityValue: string): Promise<ResolveCustomerResult> {
  return withGatewaySession(source, async (s) => {
    const res = (await gatewayFetch(s.agentUrl, s.sessionToken, '/source/customer/resolve', {
      sourceId: source.id,
      handle: s.resourceHandle,
      identityValue,
    })) as ResolveCustomerResult;
    return res;
  });
}

async function writeCustomerFieldsGateway(
  source: DataSource,
  customerRef: string,
  fields: Record<string, string>,
): Promise<WriteCustomerFieldsResult> {
  return withGatewaySession(source, async (s) => {
    const res = (await gatewayFetch(s.agentUrl, s.sessionToken, '/source/customer/write', {
      sourceId: source.id,
      customerRef,
      fields,
    })) as WriteCustomerFieldsResult;
    return res;
  });
}

async function createCustomerGateway(
  source: DataSource,
  identityValue: string,
  fields: Record<string, string>,
): Promise<CreateCustomerResult> {
  return withGatewaySession(source, async (s) => {
    const res = (await gatewayFetch(s.agentUrl, s.sessionToken, '/source/customer/create', {
      sourceId: source.id,
      handle: s.resourceHandle,
      identityValue,
      fields,
    })) as CreateCustomerResult;
    return res;
  });
}

// ===========================================================================
// Field discovery (structure only, never a value) — used by the Consent Form
// Builder to offer "map to an existing column". Read-only for both kinds.
// ===========================================================================

export async function discoverFields(source: DataSource): Promise<FieldDescriptor[]> {
  if (LOCAL_FILE_KINDS.has(source.sourceKind)) {
    const record = await getHandle(source.id);
    if (!record) throw new CustomerResolutionError('NOT_CONNECTED', 'This local file is not connected in this browser. Open its Data Viewer to connect it first.');
    const permission = await queryHandlePermission(record.handle);
    if (permission !== 'granted') throw new CustomerResolutionError('NOT_CONNECTED', 'This local file needs to be reconnected. Open its Data Viewer to reconnect.');
    let file: File;
    try {
      file = await record.handle.getFile();
    } catch {
      throw new CustomerResolutionError('FILE_NOT_FOUND', 'The connected local file could not be accessed.');
    }
    let parsed: Awaited<ReturnType<typeof parseLocalFile>>;
    try {
      parsed = await parseLocalFile(file);
    } catch (err) {
      throw new CustomerResolutionError('PERMISSION_DENIED', err instanceof LocalFileError ? err.message : 'Could not read the connected local file.');
    }
    // A local file reports no real type/nullability — headers only, same
    // "structure only, no inference" discipline as the Gateway's listFields.
    return parsed.headers.map((name) => ({ name, type: 'text', nullable: true }));
  }
  if (GATEWAY_SQL_KINDS.has(source.sourceKind)) {
    return withGatewaySession(source, async (s) => {
      const res = (await gatewayFetch(s.agentUrl, s.sessionToken, '/source/fields', {
        sourceId: source.id,
        handle: s.resourceHandle,
      })) as { fields: FieldDescriptor[] };
      return res.fields;
    });
  }
  throw new CustomerResolutionError('UNSUPPORTED_SOURCE', `Field discovery is not supported for "${source.sourceKind}" sources.`);
}

/** Clears the cached Gateway session — call after a source is disconnected/
 *  removed, or when the UI wants to force a fresh pairing next time. */
export function resetGatewaySessionCache(): void {
  cachedSession = null;
}
