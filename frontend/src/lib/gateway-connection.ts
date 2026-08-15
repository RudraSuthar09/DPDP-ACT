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

/** Given the central device record (or none) and, if present, a probe result,
 *  compute the overall state the UI should render. */
export function classifyGatewayConnection(
  device: { status: string; endpoint: string | null } | null,
  probe: HealthProbeResult | null,
): GatewayConnectionState {
  if (!device || device.status !== 'active') return 'not_configured';
  if (!device.endpoint) return 'no_endpoint';
  if (!probe) return 'offline'; // probe not yet run / failed to even start
  return classifyHealthProbe(probe);
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
