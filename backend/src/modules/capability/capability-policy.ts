/**
 * The centralized capability model's DERIVATION logic, as PURE FUNCTIONS —
 * same discipline as gateway-policy.ts / licensing-policy.ts. This is the ONE
 * place "what does plan X + deploymentType Y entitle" is decided; nowhere
 * else in the backend (or frontend) should re-derive it (locked architecture
 * §10).
 */

export type FeatureKey = 'saas' | 'enterprise' | 'enterpriseGateway' | 'databaseConnectors' | 'localConnectors';

export const KNOWN_FEATURES: readonly FeatureKey[] = ['saas', 'enterprise', 'enterpriseGateway', 'databaseConnectors', 'localConnectors'];

/**
 * Plan-based feature defaults. `enterpriseGateway` requires BOTH an
 * enterprise plan AND a client_server deployment — an enterprise plan
 * running hosted does not get it (locked architecture §10's own example).
 */
export function deriveFeatureDefaults(plan: 'saas' | 'enterprise', deploymentType: 'hosted' | 'client_server'): Record<FeatureKey, boolean> {
  return {
    saas: plan === 'saas',
    enterprise: plan === 'enterprise',
    enterpriseGateway: plan === 'enterprise' && deploymentType === 'client_server',
    databaseConnectors: true,
    localConnectors: true,
  };
}

/**
 * License `features` entitlement overrides are layered on top of plan
 * defaults — never a customer value, boolean flags only, and only KNOWN
 * keys are honoured (an unrecognised key in the jsonb column is ignored,
 * never silently added as a new capability).
 */
export function applyFeatureOverrides(
  defaults: Record<FeatureKey, boolean>,
  overrides: Record<string, unknown>,
): Record<FeatureKey, boolean> {
  const result = { ...defaults };
  for (const key of KNOWN_FEATURES) {
    if (typeof overrides[key] === 'boolean') result[key] = overrides[key] as boolean;
  }
  return result;
}
