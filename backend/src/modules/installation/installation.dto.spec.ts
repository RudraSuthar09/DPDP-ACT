import { parseRegisterInstallation } from './installation.dto';

const base = { licenseKey: 'DPDP-abcdefgh12345678', plan: 'enterprise', deploymentType: 'client_server', version: '1.0.0' };

describe('installation DTO — register-installation request parsing (I1: never accepts a credential)', () => {
  it('accepts a well-formed request', () => {
    const out = parseRegisterInstallation(base);
    expect(out).toMatchObject({ licenseKey: base.licenseKey, plan: 'enterprise', deploymentType: 'client_server', version: '1.0.0' });
    expect(out.environmentMetadata).toEqual({});
  });

  it('rejects a missing/short licenseKey', () => {
    expect(() => parseRegisterInstallation({ ...base, licenseKey: 'x' })).toThrow();
    expect(() => parseRegisterInstallation({ ...base, licenseKey: undefined })).toThrow();
  });

  it('rejects an unknown plan/deploymentType', () => {
    expect(() => parseRegisterInstallation({ ...base, plan: 'ultimate' })).toThrow();
    expect(() => parseRegisterInstallation({ ...base, deploymentType: 'on-prem' })).toThrow();
  });

  it('rejects a body carrying a credential/secret field at the top level', () => {
    for (const field of ['privateKey', 'password', 'connectionString', 'dsn']) {
      expect(() => parseRegisterInstallation({ ...base, [field]: 'x' })).toThrow();
    }
  });

  it('rejects a credential/secret field nested inside environmentMetadata', () => {
    expect(() => parseRegisterInstallation({ ...base, environmentMetadata: { password: 'x' } })).toThrow();
  });

  it('accepts non-secret environmentMetadata', () => {
    const out = parseRegisterInstallation({ ...base, environmentMetadata: { platform: 'linux', nodeVersion: '20.11.0' } });
    expect(out.environmentMetadata).toEqual({ platform: 'linux', nodeVersion: '20.11.0' });
  });

  it('rejects a missing version', () => {
    expect(() => parseRegisterInstallation({ ...base, version: '' })).toThrow();
  });
});
