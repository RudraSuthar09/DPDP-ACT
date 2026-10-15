/**
 * The /health payload. Agent METADATA ONLY.
 *
 * It reports liveness, versions, and the network MODE (loopback vs non-loopback)
 * so an operator can confirm how the agent is exposed. It deliberately does NOT
 * include the bind address/port, the origin allowlist, the control-plane URL,
 * any environment variable, any credential/token/private key, any file path, or
 * any customer data. `networkMode` is a coarse label, not the actual address.
 */
import type { GatewayHealthResponse } from '@dpdp/shared';
import { AGENT_VERSION, PROTOCOL_VERSION } from './version';
import type { NetworkMode } from './config';
import type { HeartbeatConnectionState } from './enrollment';
import type { EnrollmentErrorCode } from './startup-tasks';
import type { SourcesFileErrorCode } from './sources-file';
import type { TransportSummary } from './transport';
import type { TlsTrustSummary } from './tls-trust';
import type { ProxyCredentialsErrorCode } from './proxy-credentials';

/**
 * Local-only Gateway status (Phase 2 of the production build-out) — added
 * so the setup wizard / status app (gateway-app/) can show "Connected",
 * "last heartbeat", "N sources configured" etc. by calling the SAME
 * loopback /health route that already existed, rather than a new privileged
 * endpoint. Still metadata only: no token, no connection string, no
 * customer data, and (like every other field here) never the bind
 * address/port or the control-plane URL itself.
 */
export interface GatewayStatusSummary {
  enrolled: boolean;
  /** Non-secret — DPDP's own staff UI already shows this in the device list. */
  deviceId: string | null;
  /** 'disabled' when no control-plane URL is configured at all (so no
   *  heartbeat could ever run); null only before enrollment exists. */
  heartbeat: HeartbeatConnectionState | 'disabled' | null;
  lastHeartbeatAt: string | null;
  sourcesConfigured: number;
  storageRootsConfigured: number;
  /** Count per connector kind (e.g. { postgresql: 1, csv: 2 }). Source IDs,
   *  hosts, users and paths are deliberately NOT exposed here. */
  sourceKinds: Record<string, number>;
  /** Why the last pairing/credential step failed, if it did. Stable codes
   *  only (see startup-tasks.ts's EnrollmentErrorCode) — never a message
   *  that could carry a backend response or a secret. */
  enrollmentError: EnrollmentErrorCode | null;
  /** Why sources could not be loaded/applied, if they could not. */
  sourcesError: SourcesFileErrorCode | null;
  /** 'dpapi' on Windows when the service's own DPAPI self-test passed;
   *  'unavailable' if it failed (credentials cannot be stored); 'none' on
   *  platforms without OS credential protection (development only). */
  credentialProtection: 'dpapi' | 'unavailable' | 'none';
  /** Outbound network settings and the latest connectivity failure. Labels
   *  and counts only: never a proxy host, credential or certificate path. */
  network: GatewayNetworkSummary;
}

export interface GatewayNetworkSummary extends TransportSummary {
  tlsTrust: TlsTrustSummary;
  /** Set when proxy-credentials.json exists but could not be used. */
  proxyCredentialsError: ProxyCredentialsErrorCode | null;
  /** Latest heartbeat failure (NetworkErrorCode or HTTP_<status>); null once a heartbeat succeeds. */
  lastErrorCode: string | null;
}

/** Defaults: direct connection, Node's default trust, no failures. */
export const DEFAULT_NETWORK_SUMMARY: GatewayNetworkSummary = {
  proxy: 'none',
  proxyAuthentication: false,
  noProxyRules: 0,
  customTrust: false,
  tlsTrust: { windowsCertificateStore: false, extraCaCertificates: 0, nodeExtraCaCerts: false },
  proxyCredentialsError: null,
  lastErrorCode: null,
};

/** Extends the Phase-3A GatewayHealthResponse with the skeleton's extra fields. */
export interface AgentHealth extends GatewayHealthResponse {
  protocolVersion: string;
  networkMode: NetworkMode;
  /** Present ONLY for a local, non-browser caller (no Origin header, Host
   *  is a loopback name) — i.e. the Gateway Setup app's main process. A
   *  browser (including a DNS-rebinding page) gets liveness only. */
  gateway?: GatewayStatusSummary;
}

export function buildHealth(networkMode: NetworkMode, gateway: GatewayStatusSummary | null): AgentHealth {
  return {
    status: 'ok',
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    networkMode,
    ...(gateway ? { gateway } : {}),
  };
}
