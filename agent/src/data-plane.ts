import type {
  GatewayErrorCode,
  GatewayReadOptions,
  GatewaySourceReadResponse,
} from '@dpdp/shared';
import { ConnectorRegistry } from './connectors/registry';
import { SessionStore } from './session-store';

/**
 * The Gateway DATA PLANE. It authorizes a browser request against a local
 * session (Phase-3C, established via the control plane) and dispatches to the
 * connector for the named source. It exposes ONLY the contract's data-plane
 * operations (session/establish, discover, search, read, metadata) — no second
 * API style. Raw rows returned by read() flow straight back to the authorized
 * browser; they are never sent to Azure, persisted, or logged here.
 */

/** The one outbound call the data plane makes: redeem a pairing → session. It
 *  carries METADATA ONLY (nonce + sourceId) and returns a session token — never
 *  a customer value. Injected so it is network-agnostic and testable. */
export interface ControlPlaneClient {
  redeemPairing(input: { nonce: string; sourceId: string }): Promise<{ sessionToken: string; expiresAt: string }>;
}

export interface AgentIdentity {
  tenantId: string;
  deviceId: string;
}

export const DATA_PLANE_PATHS = new Set([
  '/session/establish',
  '/source/discover',
  '/source/search',
  '/source/read',
  '/source/metadata',
]);

export class DataPlane {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly sessions: SessionStore,
    private readonly identity: AgentIdentity,
    private readonly control: ControlPlaneClient,
  ) {}

  async establish(sourceId: string, nonce: string): Promise<{ sessionToken: string; expiresAt: string }> {
    this.registry.get(sourceId); // fail closed if the source is not configured
    const res = await this.control.redeemPairing({ nonce, sourceId });
    this.sessions.put({
      token: res.sessionToken,
      tenantId: this.identity.tenantId,
      sourceId,
      deviceId: this.identity.deviceId,
      expiresAt: Date.parse(res.expiresAt),
    });
    return res;
  }

  private connectorFor(sessionToken: string, sourceId: string) {
    // Session must be valid AND bound to this tenant + this exact source.
    this.sessions.validate(sessionToken, { tenantId: this.identity.tenantId, sourceId, now: Date.now() });
    return this.registry.get(sourceId);
  }

  async discover(sessionToken: string, sourceId: string) {
    const res = await this.connectorFor(sessionToken, sourceId).discover();
    return { ...res, sourceId };
  }

  async search(sessionToken: string, sourceId: string, term: string, opts: GatewayReadOptions) {
    return this.connectorFor(sessionToken, sourceId).search(term, opts);
  }

  async read(sessionToken: string, sourceId: string, handle: string, opts: GatewayReadOptions): Promise<GatewaySourceReadResponse> {
    return this.connectorFor(sessionToken, sourceId).read(handle, opts);
  }

  async metadata(sessionToken: string, sourceId: string, handle: string) {
    return this.connectorFor(sessionToken, sourceId).metadata(handle);
  }
}

// --- HTTP glue (kept out of server.ts; unit-testable without sockets) --------

const STATUS: Partial<Record<GatewayErrorCode, number>> = {
  INVALID_TOKEN: 401,
  SESSION_EXPIRED: 401,
  TENANT_MISMATCH: 403,
  SOURCE_MISMATCH: 403,
  SOURCE_NOT_AUTHORIZED: 403,
  PATH_NOT_ALLOWED: 403,
  PERMISSION_DENIED: 403,
  AGENT_REVOKED: 403,
  FILE_NOT_FOUND: 404,
  UNSUPPORTED_SOURCE: 404,
  RATE_LIMITED: 413,
  TIMEOUT: 504,
};

export interface DataPlaneReply {
  status: number;
  json: unknown;
}

function ok(json: unknown): DataPlaneReply {
  return { status: 200, json };
}
function fail(code: string): DataPlaneReply {
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
function opts(obj: Record<string, unknown>): GatewayReadOptions {
  return {
    limit: typeof obj.limit === 'number' ? obj.limit : undefined,
    cursor: typeof obj.cursor === 'string' ? obj.cursor : undefined,
  };
}

/**
 * Route a data-plane request. `sessionToken` is the value of the session header
 * (undefined if absent). Returns a sanitized reply — a stable code, never a raw
 * value, a path, or an internal message.
 */
export async function handleDataPlaneRequest(
  dp: DataPlane,
  ctx: { method: string; path: string; sessionToken: string | undefined; body: unknown },
): Promise<DataPlaneReply> {
  try {
    if (ctx.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    const body = asObject(ctx.body);

    if (ctx.path === '/session/establish') {
      return ok(await dp.establish(str(body, 'sourceId'), str(body, 'nonce')));
    }

    // Every other data-plane op requires a session token.
    const token = ctx.sessionToken?.trim();
    if (!token) return fail('INVALID_TOKEN');
    const sourceId = str(body, 'sourceId');

    switch (ctx.path) {
      case '/source/discover':
        return ok(await dp.discover(token, sourceId));
      case '/source/search':
        return ok(await dp.search(token, sourceId, str(body, 'term'), opts(body)));
      case '/source/read':
        return ok(await dp.read(token, sourceId, str(body, 'handle'), opts(body)));
      case '/source/metadata':
        return ok(await dp.metadata(token, sourceId, str(body, 'handle')));
      default:
        return fail('NOT_FOUND');
    }
  } catch (err) {
    // Map a coded error to its status; anything else is a generic 400. The raw
    // message is never surfaced (it could echo input); only the code is.
    const code = (err as { code?: string }).code;
    if (typeof code === 'string') return fail(code);
    return fail('BAD_REQUEST');
  }
}

/**
 * The real control-plane client: redeems a pairing at the configured control
 * plane URL, presenting the device token. Network comes from configuration — no
 * hardcoded address. Sends METADATA ONLY (nonce + sourceId); receives a token.
 */
export function httpControlPlaneClient(input: {
  controlPlaneUrl: string;
  deviceToken: string;
}): ControlPlaneClient {
  return {
    async redeemPairing({ nonce, sourceId }) {
      const res = await fetch(`${input.controlPlaneUrl}/gateway/pair/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-device-token': input.deviceToken },
        body: JSON.stringify({ nonce, sourceId }),
      });
      if (!res.ok) throw new Error('PERMISSION_DENIED');
      const json = (await res.json()) as { sessionToken: string; expiresAt: string };
      return { sessionToken: json.sessionToken, expiresAt: json.expiresAt };
    },
  };
}
