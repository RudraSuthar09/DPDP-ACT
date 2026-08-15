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

/** Extends the Phase-3A GatewayHealthResponse with the skeleton's extra fields. */
export interface AgentHealth extends GatewayHealthResponse {
  protocolVersion: string;
  networkMode: NetworkMode;
}

export function buildHealth(networkMode: NetworkMode): AgentHealth {
  return {
    status: 'ok',
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    networkMode,
  };
}
