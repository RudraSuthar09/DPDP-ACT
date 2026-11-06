/**
 * The EXISTING browser -> Gateway session handshake, in one place:
 *   1. GET  /gateway/devices/active        (the tenant's Gateway + its endpoint)
 *   2. POST /gateway/pairings              (one-time nonce, backend-brokered)
 *   3. POST {endpoint}/session/establish   (directly to the Gateway)
 *
 * Used by the per-source Gateway browser and by customer resolution, so
 * neither asks the user for a Gateway address or a session token: the
 * endpoint is the one the Gateway registered itself (heartbeat) or that an
 * administrator configured. Data still flows only browser <-> Gateway.
 */
import { apiFetch, ApiError } from './api';

export interface GatewaySession {
  deviceId: string;
  agentUrl: string;
  sessionToken: string;
  expiresAt: number;
}

export type GatewaySessionFailure = 'AGENT_NOT_ENROLLED' | 'NOT_CONNECTED' | 'SOURCE_NOT_AUTHORIZED' | 'TIMEOUT';

export class GatewaySessionError extends Error {
  constructor(
    public readonly code: GatewaySessionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GatewaySessionError';
  }
}

export async function openGatewaySession(sourceId: string): Promise<GatewaySession> {
  let device: { id: string; endpoint: string | null; status: string } | null;
  try {
    device = (await apiFetch<{ device: { id: string; endpoint: string | null; status: string } | null }>('/gateway/devices/active')).device;
  } catch (err) {
    throw new GatewaySessionError('AGENT_NOT_ENROLLED', err instanceof ApiError ? err.message : 'Could not reach the Gateway configuration.');
  }
  if (!device || device.status !== 'active') {
    throw new GatewaySessionError('AGENT_NOT_ENROLLED', 'No active Gateway is connected for this workspace.');
  }
  if (!device.endpoint) {
    throw new GatewaySessionError(
      'NOT_CONNECTED',
      'The Gateway has not reported its local address yet. Make sure the DPDP Gateway service is running on this computer, then retry.',
    );
  }

  let nonce: string;
  try {
    nonce = (await apiFetch<{ nonce: string; expiresAt: string }>('/gateway/pairings', { method: 'POST', body: { sourceId, deviceId: device.id } }))
      .nonce;
  } catch (err) {
    throw new GatewaySessionError('SOURCE_NOT_AUTHORIZED', err instanceof ApiError ? err.message : 'Could not create a Gateway pairing for this source.');
  }

  const agentUrl = device.endpoint.replace(/\/+$/, '');
  const res = await fetch(`${agentUrl}/session/establish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, nonce }),
  }).catch(() => null);
  if (!res) {
    throw new GatewaySessionError(
      'TIMEOUT',
      'This browser could not reach the Gateway. Folder and data browsing works from the computer where the DPDP Gateway is installed.',
    );
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GatewaySessionError(
      'SOURCE_NOT_AUTHORIZED',
      j.error === 'SOURCE_NOT_AUTHORIZED'
        ? 'The Gateway is not sharing this folder any more. On the Gateway computer, open DPDP Gateway Setup → Folders DPDP may use and allow it again.'
        : `The Gateway refused the session (${j.error ?? res.status}).`,
    );
  }
  const established = (await res.json()) as { sessionToken: string; expiresAt: string };
  return { deviceId: device.id, agentUrl, sessionToken: established.sessionToken, expiresAt: Date.parse(established.expiresAt) };
}
