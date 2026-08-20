/**
 * DPDP Gateway Core has exactly one implementation (enrollment, auth, device
 * identity, sessions, heartbeat, connector registry — GatewayService/
 * GatewayRepository). "SaaS Gateway" and "Enterprise Gateway" are PROFILES of
 * that one core, not separate implementations (locked architecture §5) —
 * this is the entire abstraction: a pure derivation from the installation's
 * deployment_type, never a duplicated column or a second code path.
 */
export type GatewayProfile = 'saas' | 'enterprise';

export function resolveGatewayProfile(deploymentType: 'hosted' | 'client_server'): GatewayProfile {
  return deploymentType === 'client_server' ? 'enterprise' : 'saas';
}
