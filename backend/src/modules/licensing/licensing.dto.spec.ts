import { parseIssueLicense } from './licensing.dto';

describe('licensing DTO — issue-license request parsing', () => {
  it('accepts a well-formed request', () => {
    const out = parseIssueLicense({ plan: 'enterprise', deploymentType: 'client_server' });
    expect(out).toMatchObject({ plan: 'enterprise', deploymentType: 'client_server', features: {}, expiresAt: null });
  });

  it('rejects an unknown plan', () => {
    expect(() => parseIssueLicense({ plan: 'ultimate', deploymentType: 'hosted' })).toThrow();
  });

  it('rejects an unknown deploymentType', () => {
    expect(() => parseIssueLicense({ plan: 'saas', deploymentType: 'on-prem' })).toThrow();
  });

  it('accepts an explicit features object', () => {
    const out = parseIssueLicense({ plan: 'saas', deploymentType: 'hosted', features: { databaseConnectors: false } });
    expect(out.features).toEqual({ databaseConnectors: false });
  });

  it('rejects a non-object features value', () => {
    expect(() => parseIssueLicense({ plan: 'saas', deploymentType: 'hosted', features: 'yes' })).toThrow();
  });

  it('parses a valid ISO expiresAt', () => {
    const out = parseIssueLicense({ plan: 'saas', deploymentType: 'hosted', expiresAt: '2027-01-01T00:00:00Z' });
    expect(out.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects a malformed expiresAt', () => {
    expect(() => parseIssueLicense({ plan: 'saas', deploymentType: 'hosted', expiresAt: 'not-a-date' })).toThrow();
  });
});
