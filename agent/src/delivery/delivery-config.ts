import { AgentConfigError } from '../config';

const DEFAULT_POLL_INTERVAL_SECONDS = 10;

export interface DeliveryConfig {
  pollIntervalSeconds: number;
}

/** How often the delivery poller checks for pending submissions. Separate
 *  from GATEWAY_HEARTBEAT_INTERVAL_SECONDS on purpose — delivery latency and
 *  presence heartbeat are different concerns with different acceptable
 *  cadences. */
export function loadDeliveryConfig(env: NodeJS.ProcessEnv = process.env): DeliveryConfig {
  const raw = env.AGENT_DELIVERY_POLL_INTERVAL_SECONDS;
  const pollIntervalSeconds = raw === undefined || raw === '' ? DEFAULT_POLL_INTERVAL_SECONDS : Number(raw);
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 2) {
    throw new AgentConfigError('AGENT_DELIVERY_POLL_INTERVAL_SECONDS must be an integer of at least 2.');
  }
  return { pollIntervalSeconds };
}
