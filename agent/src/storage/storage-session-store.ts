import type { GatewayErrorCode } from '@dpdp/shared';

/** In-memory session store for the STORAGE data plane — the sibling of
 *  session-store.ts's SessionStore, scoped to storageRootId instead of
 *  sourceId. Sessions are transient (memory only); nothing here is
 *  persisted, and nothing here is a customer value. */

export class StorageSessionError extends Error {
  constructor(public readonly code: GatewayErrorCode) {
    super(code);
    this.name = 'StorageSessionError';
  }
}

export interface GatewayLocalStorageSession {
  token: string;
  tenantId: string;
  storageRootId: string;
  deviceId: string;
  /** epoch ms */
  expiresAt: number;
}

export class StorageSessionStore {
  private readonly byToken = new Map<string, GatewayLocalStorageSession>();

  put(session: GatewayLocalStorageSession): void {
    this.byToken.set(session.token, session);
  }

  validate(token: string, ctx: { tenantId: string; storageRootId: string; now: number }): GatewayLocalStorageSession {
    const s = this.byToken.get(token);
    if (!s) throw new StorageSessionError('INVALID_TOKEN');
    if (ctx.now > s.expiresAt) throw new StorageSessionError('SESSION_EXPIRED');
    if (s.tenantId !== ctx.tenantId) throw new StorageSessionError('TENANT_MISMATCH');
    if (s.storageRootId !== ctx.storageRootId) throw new StorageSessionError('STORAGE_ROOT_MISMATCH');
    return s;
  }
}
