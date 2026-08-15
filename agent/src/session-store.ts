import type { GatewayErrorCode } from '@dpdp/shared';

/**
 * In-memory session store for the data plane. A session is established once the
 * Gateway has redeemed a Phase-3C pairing against the control plane (Azure) and
 * received a session token; from then on the browser presents that token to the
 * Gateway DIRECTLY and the Gateway authorizes locally — Azure is never in the
 * raw-data path. Sessions are transient (memory only), tenant/source/device
 * scoped, and time-limited; nothing here is persisted.
 */

export class SessionError extends Error {
  constructor(public readonly code: GatewayErrorCode) {
    super(code);
    this.name = 'SessionError';
  }
}

export interface GatewayLocalSession {
  token: string;
  tenantId: string;
  sourceId: string;
  deviceId: string;
  /** epoch ms */
  expiresAt: number;
}

export class SessionStore {
  private readonly byToken = new Map<string, GatewayLocalSession>();

  put(session: GatewayLocalSession): void {
    this.byToken.set(session.token, session);
  }

  /**
   * Validate a presented token against the tenant it must belong to and the
   * source the request names. Fails closed on unknown/expired/mismatched — no
   * customer data is ever released without a passing session.
   */
  validate(
    token: string,
    ctx: { tenantId: string; sourceId: string; now: number },
  ): GatewayLocalSession {
    const s = this.byToken.get(token);
    if (!s) throw new SessionError('INVALID_TOKEN');
    if (ctx.now > s.expiresAt) throw new SessionError('SESSION_EXPIRED');
    if (s.tenantId !== ctx.tenantId) throw new SessionError('TENANT_MISMATCH');
    if (s.sourceId !== ctx.sourceId) throw new SessionError('SOURCE_MISMATCH');
    return s;
  }
}
