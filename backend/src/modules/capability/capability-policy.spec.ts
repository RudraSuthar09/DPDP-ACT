import { deriveFeatureDefaults, applyFeatureOverrides } from './capability-policy';

describe('locked architecture §10 — capability derivation (plan defaults)', () => {
  it('1. SaaS license activates SaaS capabilities', () => {
    const features = deriveFeatureDefaults('saas', 'hosted');
    expect(features).toMatchObject({ saas: true, enterprise: false, enterpriseGateway: false });
  });

  it('2. Enterprise + client_server license activates Enterprise capabilities', () => {
    const features = deriveFeatureDefaults('enterprise', 'client_server');
    expect(features).toMatchObject({ saas: false, enterprise: true, enterpriseGateway: true });
  });

  it('an Enterprise plan running hosted does NOT get enterpriseGateway', () => {
    const features = deriveFeatureDefaults('enterprise', 'hosted');
    expect(features).toMatchObject({ enterprise: true, enterpriseGateway: false });
  });

  it('3. SaaS cannot access Enterprise-only functionality (enterpriseGateway false)', () => {
    expect(deriveFeatureDefaults('saas', 'hosted').enterpriseGateway).toBe(false);
    expect(deriveFeatureDefaults('saas', 'client_server').enterpriseGateway).toBe(false); // saas plan never gets it, even if misconfigured deploymentType
  });

  it('4. Enterprise does not accidentally expose SaaS-only functionality', () => {
    expect(deriveFeatureDefaults('enterprise', 'client_server').saas).toBe(false);
  });

  it('databaseConnectors/localConnectors are on for both plans by default (no fabricated restriction)', () => {
    expect(deriveFeatureDefaults('saas', 'hosted')).toMatchObject({ databaseConnectors: true, localConnectors: true });
    expect(deriveFeatureDefaults('enterprise', 'client_server')).toMatchObject({ databaseConnectors: true, localConnectors: true });
  });
});

describe('license feature-entitlement overrides', () => {
  const base = deriveFeatureDefaults('enterprise', 'client_server');

  it('a known boolean override wins over the plan default', () => {
    expect(applyFeatureOverrides(base, { databaseConnectors: false }).databaseConnectors).toBe(false);
  });

  it('an unknown key is ignored — never silently becomes a new capability', () => {
    const out = applyFeatureOverrides(base, { somethingUnrecognised: true });
    expect(out).not.toHaveProperty('somethingUnrecognised');
  });

  it('a non-boolean value for a known key is ignored (fails closed to the plan default)', () => {
    const out = applyFeatureOverrides(base, { enterpriseGateway: 'yes' as unknown as boolean });
    expect(out.enterpriseGateway).toBe(true); // unchanged from base, malformed override discarded
  });

  it('an empty overrides object leaves plan defaults unmodified', () => {
    expect(applyFeatureOverrides(base, {})).toEqual(base);
  });
});
