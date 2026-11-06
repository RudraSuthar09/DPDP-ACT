/**
 * The browser -> Gateway STORAGE-plane handshake and folder browsing — the
 * client half of the EXISTING, already-tested protocol:
 *
 *   1. GET  /gateway/devices/active                  (the tenant's Gateway)
 *   2. POST /storage/roots/:id/gateway-pairings      (one-time nonce, brokered)
 *   3. POST {endpoint}/storage/session/establish     (directly to the Gateway)
 *   4. POST {endpoint}/storage/browse | /storage/folder/create
 *
 * Deliberately separate from gateway-session.ts: that one is bound to a
 * data SOURCE id (reading), this one to a STORAGE ROOT id (writing). The two
 * planes have separate pairings, sessions and session stores in the Gateway,
 * which is exactly what keeps read and write authorization independent — a
 * readable source can never be written to through a storage session, and a
 * writable location is never readable through a data session.
 *
 * Folders only: the storage plane has no file-listing or file-reading
 * capability at all (see agent/src/storage/storage-boundary.spec.ts).
 */
import { apiFetch, ApiError } from './api';

export interface GatewayStorageSession {
  storageRootId: string;
  agentUrl: string;
  sessionToken: string;
  expiresAt: number;
}

export type StorageSessionFailure = 'AGENT_NOT_ENROLLED' | 'NOT_CONNECTED' | 'NOT_AUTHORIZED' | 'TIMEOUT';

export class GatewayStorageSessionError extends Error {
  constructor(
    public readonly code: StorageSessionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayStorageSessionError';
  }
}

export async function openGatewayStorageSession(storageRootId: string): Promise<GatewayStorageSession> {
  let device: { id: string; endpoint: string | null; status: string } | null;
  try {
    device = (await apiFetch<{ device: { id: string; endpoint: string | null; status: string } | null }>('/gateway/devices/active')).device;
  } catch (err) {
    throw new GatewayStorageSessionError('AGENT_NOT_ENROLLED', err instanceof ApiError ? err.message : 'Could not reach the Gateway configuration.');
  }
  if (!device || device.status !== 'active') {
    throw new GatewayStorageSessionError('AGENT_NOT_ENROLLED', 'No active Gateway is connected for this workspace.');
  }
  if (!device.endpoint) {
    throw new GatewayStorageSessionError(
      'NOT_CONNECTED',
      'The Gateway has not reported its local address yet. Make sure the DPDP Gateway service is running, then retry.',
    );
  }

  let nonce: string;
  try {
    nonce = (await apiFetch<{ nonce: string; expiresAt: string }>(`/storage/roots/${storageRootId}/gateway-pairings`, { method: 'POST' })).nonce;
  } catch (err) {
    throw new GatewayStorageSessionError('NOT_AUTHORIZED', err instanceof ApiError ? err.message : 'Could not create a Gateway pairing for this location.');
  }

  const agentUrl = device.endpoint.replace(/\/+$/, '');
  const res = await fetch(`${agentUrl}/storage/session/establish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storageRootId, nonce }),
  }).catch(() => null);
  if (!res) {
    throw new GatewayStorageSessionError(
      'TIMEOUT',
      'This browser could not reach the Gateway. Browsing works from the computer where the DPDP Gateway is installed.',
    );
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GatewayStorageSessionError('NOT_AUTHORIZED', storageRefusalMessage(j.error, res.status));
  }
  const established = (await res.json()) as { sessionToken: string; expiresAt: string };
  return { storageRootId, agentUrl, sessionToken: established.sessionToken, expiresAt: Date.parse(established.expiresAt) };
}

/** A refusal is reported as the Gateway's own stable code, translated into
 *  what the administrator must do — never a path and never a raw message. */
export function storageRefusalMessage(code: string | undefined, status?: number): string {
  if (code === 'STORAGE_ROOT_NOT_AUTHORIZED') {
    return 'This Gateway has no folder authorized for this location yet. In DPDP Gateway Setup → Manage sources, choose the folder, pick "Write" (or "Read and write"), and paste this location\'s ID.';
  }
  if (code === 'PERMISSION_DENIED') {
    return 'The Gateway service account cannot use that folder. Give it permission to create files there, then retry.';
  }
  if (code === 'FILE_NOT_FOUND') return 'That folder no longer exists on the Gateway computer.';
  if (code === 'PATH_NOT_ALLOWED') return 'That folder is outside the authorized location.';
  return `The Gateway refused the request (${code ?? status ?? 'error'}).`;
}

const SESSION_HEADER = 'x-dpdp-gateway-session';

async function storagePost<T>(session: GatewayStorageSession, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${session.agentUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: session.sessionToken },
    body: JSON.stringify({ storageRootId: session.storageRootId, ...body }),
  }).catch(() => null);
  if (!res) throw new GatewayStorageSessionError('TIMEOUT', 'This browser could not reach the Gateway.');
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GatewayStorageSessionError('NOT_AUTHORIZED', storageRefusalMessage(j.error, res.status));
  }
  return (await res.json()) as T;
}

/** The DIRECT SUBFOLDERS of `path` inside the authorized location. `path` is
 *  an array of folder NAMES — never an OS path; the Gateway re-checks
 *  containment on every call. */
export function browseStorageFolders(session: GatewayStorageSession, path: readonly string[]): Promise<{ entries: Array<{ name: string }> }> {
  return storagePost(session, '/storage/browse', { path });
}

/** Creates one real subfolder on the Gateway computer. Idempotent there. */
export function createStorageFolder(session: GatewayStorageSession, path: readonly string[], name: string): Promise<{ created: true }> {
  return storagePost(session, '/storage/folder/create', { path, name });
}

/**
 * Writes one file into the authorized location, through the Gateway's own
 * storage plane — the SAME session-bound, containment-checked route the
 * submission delivery path uses. Nothing new: this browser can only reach a
 * folder the Gateway administrator granted WRITE on, the session is bound to
 * that one storage root, and the Gateway re-checks containment itself.
 *
 * `overwrite` defaults to FALSE, so an existing file of the same name makes
 * the Gateway refuse rather than silently replace someone's spreadsheet. A
 * caller that means to replace it has to say so.
 */
export function writeStorageFile(
  session: GatewayStorageSession,
  input: { path: readonly string[]; filename: string; contentBase64: string; overwrite?: boolean },
): Promise<{ written: true; path?: string[] }> {
  return storagePost(session, '/storage/write', {
    path: input.path,
    filename: input.filename,
    contentBase64: input.contentBase64,
    overwrite: input.overwrite === true,
  });
}
