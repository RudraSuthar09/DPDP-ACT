/**
 * Phase 3G-2.5 — pure classification of a Gateway's reachability, kept separate
 * from the component so it is a plain, testable function (no React, no fetch).
 * The caller supplies the OUTCOME of trying to reach `${endpoint}/health`; this
 * function only decides what state that outcome means. It NEVER throws.
 */

export type GatewayConnectionState =
  | 'not_configured' // no active device centrally enrolled at all
  | 'no_endpoint' // a device is enrolled, but no endpoint has been set yet
  | 'connected' // endpoint reachable, /health responded ok
  | 'offline' // endpoint unreachable (network failure/timeout)
  | 'invalid'; // endpoint reachable but did not answer like a DPDP Gateway

export interface HealthProbeResult {
  /** true if the HTTP request itself completed (regardless of status code). */
  reached: boolean;
  /** The parsed JSON body, if any could be parsed. */
  body?: { status?: unknown; agentVersion?: unknown } | null;
}

/** Classify a probe result. Pure — given the same input, always the same output. */
export function classifyHealthProbe(probe: HealthProbeResult): 'connected' | 'offline' | 'invalid' {
  if (!probe.reached) return 'offline';
  if (probe.body && probe.body.status === 'ok' && typeof probe.body.agentVersion === 'string') {
    return 'connected';
  }
  return 'invalid';
}

/** Online = DPDP received a heartbeat this recently. The Gateway sends one
 *  immediately at start-up and then every 60 s by default, so three missed
 *  intervals means it is genuinely not connected. */
export const HEARTBEAT_ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function isHeartbeatRecent(lastHeartbeatAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastHeartbeatAt) return false;
  const at = Date.parse(lastHeartbeatAt);
  return Number.isFinite(at) && now - at <= HEARTBEAT_ONLINE_WINDOW_MS && at - now <= HEARTBEAT_ONLINE_WINDOW_MS;
}

/**
 * The Gateway's connection to DPDP -- decided by the CENTRAL record's last
 * heartbeat (the authenticated device-to-backend link), not by whether THIS
 * browser can open the Gateway's local address. Phase 6: deciding it from a
 * browser probe of a manually entered endpoint showed a paired, heart-beating
 * Gateway as needing configuration.
 */
export function classifyGatewayConnection(
  device: { status: string; endpoint: string | null; lastHeartbeatAt?: string | null } | null,
  _probe: HealthProbeResult | null,
  now: number = Date.now(),
): GatewayConnectionState {
  if (!device || device.status !== 'active') return 'not_configured';
  return isHeartbeatRecent(device.lastHeartbeatAt, now) ? 'connected' : 'offline';
}

export type BrowserAccessState =
  | 'no_endpoint' // the Gateway has not reported a local address (and none was entered)
  | 'reachable' // this browser can open the Gateway's local address
  | 'unreachable' // it cannot (e.g. the dashboard is open on another computer)
  | 'invalid'; // something answered, but not a DPDP Gateway

/**
 * Whether THIS browser can reach the Gateway's local address -- needed only
 * for browsing folders/data through the Gateway, which happens directly
 * between the browser and the Gateway, never through the backend.
 */
export function classifyBrowserAccess(device: { endpoint: string | null } | null, probe: HealthProbeResult | null): BrowserAccessState {
  if (!device || !device.endpoint) return 'no_endpoint';
  if (!probe) return 'unreachable';
  const r = classifyHealthProbe(probe);
  return r === 'connected' ? 'reachable' : r === 'offline' ? 'unreachable' : 'invalid';
}

/**
 * Probe `${endpoint}/health` directly (never through the central backend — the
 * whole point is to check whether THIS browser can reach the Gateway). Never
 * throws: any failure (network, timeout, malformed JSON) becomes
 * `{ reached: false }`, which classifyGatewayConnection reports as "offline".
 * A 5s timeout keeps a dead/firewalled endpoint from hanging the UI.
 */
export async function probeGatewayHealth(endpoint: string): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/health`, { signal: controller.signal });
    if (!res.ok) return { reached: true, body: null };
    const body = (await res.json().catch(() => null)) as HealthProbeResult['body'];
    return { reached: true, body };
  } catch {
    return { reached: false };
  } finally {
    clearTimeout(timer);
  }
}
