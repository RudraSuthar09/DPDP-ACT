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
 * Plan-based feature defaults. `enterpriseGateway` follows the PLAN only:
 * every Enterprise tenant gets it, whichever deployment type it runs —
 * Enterprise + hosted (the production model: DPDP hosted centrally, the
 * customer runs their own Gateway agents) and Enterprise + client_server
 * alike. A SaaS plan never gets it, on either deployment type.
 * `deploymentType` is kept in the signature: it still drives everything else
 * that reads it (licence matching, installation records, Gateway profile).
 */
export function deriveFeatureDefaults(plan: 'saas' | 'enterprise', _deploymentType: 'hosted' | 'client_server'): Record<FeatureKey, boolean> {
  return {
    saas: plan === 'saas',
    enterprise: plan === 'enterprise',
    enterpriseGateway: plan === 'enterprise',
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
