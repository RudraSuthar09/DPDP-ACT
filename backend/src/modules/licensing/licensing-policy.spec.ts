import { evaluateLicenseForActivation, type LicenseForValidation } from './licensing-policy';

const now = new Date('2026-08-16T12:00:00Z');
const future = new Date('2026-08-16T13:00:00Z');
const past = new Date('2026-08-16T11:00:00Z');

function license(over: Partial<LicenseForValidation> = {}): LicenseForValidation {
  return {
    plan: 'enterprise',
    deployment_type: 'client_server',
    status: 'pending',
    expires_at: null,
    approved_at: now,
    ...over,
  };
}

const enterpriseRequest = { plan: 'enterprise' as const, deploymentType: 'client_server' as const };
const saasRequest = { plan: 'saas' as const, deploymentType: 'hosted' as const };

describe('locked architecture §9/§12 — license validation policy', () => {
  it('a pending, unexpired, matching license is accepted', () => {
    expect(evaluateLicenseForActivation(license(), enterpriseRequest, now)).toEqual({ ok: true });
  });

  it('an already-active, matching license is still accepted (idempotent re-registration)', () => {
    expect(evaluateLicenseForActivation(license({ status: 'active' }), enterpriseRequest, now)).toEqual({ ok: true });
  });

  it('12/13. an unrecognised license key (null) is rejected', () => {
    expect(evaluateLicenseForActivation(null, enterpriseRequest, now)).toMatchObject({ ok: false });
  });

  it('13. a revoked license cannot activate protected capabilities', () => {
    expect(evaluateLicenseForActivation(license({ status: 'revoked' }), enterpriseRequest, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('revoked'),
    });
  });

  it('13. an expired license cannot activate protected capabilities', () => {
    expect(evaluateLicenseForActivation(license({ expires_at: past }), enterpriseRequest, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('expired'),
    });
  });

  it('a not-yet-expired license (expires_at in the future) is accepted', () => {
    expect(evaluateLicenseForActivation(license({ expires_at: future }), enterpriseRequest, now)).toEqual({ ok: true });
  });

  it('an "expired" lifecycle-status license is rejected even if expires_at is null', () => {
    expect(evaluateLicenseForActivation(license({ status: 'expired' }), enterpriseRequest, now)).toMatchObject({ ok: false });
  });

  it('1/3. a SaaS license cannot activate an Enterprise/client_server installation', () => {
    const saasLicense = license({ plan: 'saas', deployment_type: 'hosted' });
    expect(evaluateLicenseForActivation(saasLicense, enterpriseRequest, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('saas/hosted'),
    });
  });

  it('2/4. an Enterprise license cannot activate a SaaS/hosted installation', () => {
    expect(evaluateLicenseForActivation(license(), saasRequest, now)).toMatchObject({ ok: false });
  });

  it('plan matching deploymentType mismatched is still rejected (exact match required, no partial grants)', () => {
    const enterpriseHosted = license({ plan: 'enterprise', deployment_type: 'hosted' });
    expect(evaluateLicenseForActivation(enterpriseHosted, enterpriseRequest, now)).toMatchObject({ ok: false });
  });

  it('platform-admin approval gate: an unapproved license is rejected even when otherwise perfectly valid', () => {
    expect(evaluateLicenseForActivation(license({ approved_at: null }), enterpriseRequest, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('approval'),
    });
  });

  it('platform-admin approval gate: the approval check wins over a revoked/expired reason (reads as "not reviewed", not a more specific rejection)', () => {
    const unapprovedAndRevoked = license({ approved_at: null, status: 'revoked' });
    expect(evaluateLicenseForActivation(unapprovedAndRevoked, enterpriseRequest, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('approval'),
    });
  });

  it('an approved license (approved_at set) with everything else valid is accepted', () => {
    expect(evaluateLicenseForActivation(license({ approved_at: past }), enterpriseRequest, now)).toEqual({ ok: true });
  });
});
