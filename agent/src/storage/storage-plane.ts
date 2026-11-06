import type { GatewayErrorCode, GatewayStoragePath } from '@dpdp/shared';
import { StorageRegistry } from './registry';
import { StorageSessionStore } from './storage-session-store';

/**
 * The Gateway STORAGE data plane. It authorizes a browser request against a
 * local storage session (established via the storage-plane control-plane
 * pairing, see storage-gateway.service.ts) and dispatches to the
 * StorageProvider for the named storage root. Folders, plus one narrow
 * write (/storage/write -> StorageConnector.writeFile). Never a file-content
 * READ.
 */

/** The one outbound call the storage plane makes: redeem a storage pairing ->
 *  session. Injected so it is network-agnostic and testable — the real HTTP
 *  implementation is the SAME control-plane client as the data plane's
 *  (enrollment.ts's createControlPlaneClient), extended with one more method
 *  rather than a second client. */
export interface StorageControlPlaneClient {
  redeemStoragePairing(input: { nonce: string; storageRootId: string }): Promise<{ sessionToken: string; expiresAt: string }>;
}

export interface AgentIdentity {
  tenantId: string;
  deviceId: string;
}

export const STORAGE_PLANE_PATHS = new Set([
  '/storage/session/establish',
  '/storage/browse',
  '/storage/folder/create',
  '/storage/folder/verify',
  '/storage/write',
]);

/** Body size cap for /storage/write specifically — the server's global
 *  MAX_CONTENT_LENGTH (server.ts) stays 4096 for every other route (health,
 *  data-plane control messages); raising that global cap would weaken a
 *  resource guard that protects routes with no legitimate reason to carry a
 *  large body. Write's own request body is base64 file content, so it alone
 *  gets a larger, EXPLICIT cap, enforced here before the body is even read
 *  (see server.ts's per-route oversized check). */
export const STORAGE_WRITE_MAX_CONTENT_LENGTH = Math.ceil((15 * 1024 * 1024 * 4) / 3) + 4096;

export class StoragePlane {
  constructor(
    private readonly registry: StorageRegistry,
    private readonly sessions: StorageSessionStore,
    private readonly identity: AgentIdentity,
    private readonly control: StorageControlPlaneClient,
  ) {}

  async establish(storageRootId: string, nonce: string): Promise<{ sessionToken: string; expiresAt: string }> {
    this.registry.get(storageRootId); // fail closed if the root is not configured
    const res = await this.control.redeemStoragePairing({ nonce, storageRootId });
    this.sessions.put({
      token: res.sessionToken,
      tenantId: this.identity.tenantId,
      storageRootId,
      deviceId: this.identity.deviceId,
      expiresAt: Date.parse(res.expiresAt),
    });
    return res;
  }

  private providerFor(sessionToken: string, storageRootId: string) {
    this.sessions.validate(sessionToken, { tenantId: this.identity.tenantId, storageRootId, now: Date.now() });
    return this.registry.get(storageRootId);
  }

  async browse(sessionToken: string, storageRootId: string, path: GatewayStoragePath) {
    return this.providerFor(sessionToken, storageRootId).browse(path);
  }

  async createFolder(sessionToken: string, storageRootId: string, path: GatewayStoragePath, name: string) {
    return this.providerFor(sessionToken, storageRootId).createFolder(path, name);
  }

  async verifyFolder(sessionToken: string, storageRootId: string, path: GatewayStoragePath) {
    return this.providerFor(sessionToken, storageRootId).verifyFolder(path);
  }

  /** Same session-bound authorization as browse/createFolder/verifyFolder —
   *  there is no separate "write-enabled" permission bit; an established
   *  storage session for a root may write within it, exactly as it may
   *  already browse and create folders within it (a storage root IS a write
   *  destination by design — see the storage-configuration migration's own
   *  header). Fails closed (UNSUPPORTED_SOURCE) if this provider has no
   *  writeFile at all — defensive only; GatewayStorageProvider always has one. */
  async writeFile(sessionToken: string, storageRootId: string, path: GatewayStoragePath, filename: string, contentBase64: string, overwrite: boolean) {
    const provider = this.providerFor(sessionToken, storageRootId);
    if (!provider.writeFile) throw Object.assign(new Error('UNSUPPORTED_SOURCE'), { code: 'UNSUPPORTED_SOURCE' });
    return provider.writeFile(path, filename, contentBase64, overwrite);
  }
}

// --- HTTP glue (kept out of server.ts; unit-testable without sockets) --------

const STATUS: Partial<Record<GatewayErrorCode, number>> = {
  INVALID_TOKEN: 401,
  SESSION_EXPIRED: 401,
  TENANT_MISMATCH: 403,
  STORAGE_ROOT_MISMATCH: 403,
  STORAGE_ROOT_NOT_AUTHORIZED: 403,
  PATH_NOT_ALLOWED: 403,
  PERMISSION_DENIED: 403,
  AGENT_REVOKED: 403,
  FILE_NOT_FOUND: 404,
  RATE_LIMITED: 413,
  TIMEOUT: 504,
  FILE_ALREADY_EXISTS: 409,
  INVALID_FILENAME: 400,
  UNSUPPORTED_SOURCE: 404,
};

export interface StoragePlaneReply {
  status: number;
  json: unknown;
}

function ok(json: unknown): StoragePlaneReply {
  return { status: 200, json };
}
function fail(code: string): StoragePlaneReply {
  return { status: STATUS[code as GatewayErrorCode] ?? 400, json: { error: code } };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('BAD_REQUEST');
  return body as Record<string, unknown>;
}
function str(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) throw new Error('BAD_REQUEST');
  return v;
}
/** A folder path: an array of plain folder-name strings. Rejects anything
 *  that isn't a flat string array at the HTTP edge, before path-safety's own
 *  per-segment validation ever runs — defence in depth, same layering as
 *  data-plane.ts's fieldsObject()/columnType(). */
/** Raw base64 text, bounded (defence in depth ahead of the provider's own
 *  byte-length check against MAX_WRITE_BYTES) — not decoded here, so a
 *  malformed value is the connector's INVALID_FILENAME, not a crash here. */
function contentBase64(obj: Record<string, unknown>): string {
  const v = obj['contentBase64'];
  if (typeof v !== 'string' || v.length === 0 || v.length > STORAGE_WRITE_MAX_CONTENT_LENGTH) throw new Error('BAD_REQUEST');
  return v;
}
function overwriteFlag(obj: Record<string, unknown>): boolean {
  return obj['overwrite'] === true;
}
function storagePath(obj: Record<string, unknown>): GatewayStoragePath {
  const raw = obj['path'];
  if (!Array.isArray(raw)) throw new Error('BAD_REQUEST');
  if (raw.length > 32) throw new Error('BAD_REQUEST'); // no unbounded nesting
  return raw.map((seg) => {
    if (typeof seg !== 'string') throw new Error('BAD_REQUEST');
    return seg;
  });
}

/**
 * Route a storage-plane request. `sessionToken` is the value of the session
 * header (undefined if absent). Returns a sanitized reply — a stable code,
 * never a raw path or internal message.
 */
export async function handleStoragePlaneRequest(
  sp: StoragePlane,
  ctx: { method: string; path: string; sessionToken: string | undefined; body: unknown },
): Promise<StoragePlaneReply> {
  try {
    if (ctx.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const body = asObject(ctx.body);

    if (ctx.path === '/storage/session/establish') {
      return ok(await sp.establish(str(body, 'storageRootId'), str(body, 'nonce')));
    }

    const token = ctx.sessionToken?.trim();
    if (!token) return fail('INVALID_TOKEN');
    const storageRootId = str(body, 'storageRootId');

    switch (ctx.path) {
      case '/storage/browse':
        return ok(await sp.browse(token, storageRootId, storagePath(body)));
      case '/storage/folder/create':
        return ok(await sp.createFolder(token, storageRootId, storagePath(body), str(body, 'name')));
      case '/storage/folder/verify':
        return ok(await sp.verifyFolder(token, storageRootId, storagePath(body)));
      case '/storage/write':
        return ok(await sp.writeFile(token, storageRootId, storagePath(body), str(body, 'filename'), contentBase64(body), overwriteFlag(body)));
      default:
        return fail('NOT_FOUND');
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (typeof code === 'string') return fail(code);
    return fail('BAD_REQUEST');
  }
}
