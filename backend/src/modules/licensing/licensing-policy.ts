/**
 * License validation, as a PURE FUNCTION — same discipline as gateway-policy.ts:
 * every accept/reject in "does this license entitle the requested deployment
 * configuration" lives here, decoupled from the database and HTTP, so it can
 * be read and tested exhaustively in one place. LicensingService fetches the
 * row (under RLS) and asks this function whether to proceed; it never
 * re-implements the check inline.
 */

export type LicensePolicyResult = { ok: true } | { ok: false; reason: string };

const OK: LicensePolicyResult = { ok: true };
const fail = (reason: string): LicensePolicyResult => ({ ok: false, reason });

export interface LicenseForValidation {
  plan: 'saas' | 'enterprise';
  deployment_type: 'hosted' | 'client_server';
  status: 'pending' | 'active' | 'expired' | 'revoked';
  expires_at: Date | null;
}

export interface RequestedDeployment {
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
}

/**
 * A license entitles the requested installation configuration iff: it exists
 * (caller checks null separately — NotFound, not this function's job), it is
 * not revoked, it is not expired, its lifecycle status is one that can still
 * be activated/re-registered (`pending` or `active` — never `expired`), and
 * its plan/deployment_type match the request EXACTLY (no mixing, no partial
 * grants — locked architecture §9).
 */
export function evaluateLicenseForActivation(
  license: LicenseForValidation | null,
  requested: RequestedDeployment,
  now: Date,
): LicensePolicyResult {
  if (!license) return fail('license key not recognised');
  if (license.status === 'revoked') return fail('license has been revoked');
  if (license.expires_at && license.expires_at.getTime() <= now.getTime()) return fail('license has expired');
  if (license.status !== 'pending' && license.status !== 'active') return fail('license is not currently valid');
  if (license.plan !== requested.plan || license.deployment_type !== requested.deploymentType) {
    return fail(
      `license entitles ${license.plan}/${license.deployment_type}, not the requested ${requested.plan}/${requested.deploymentType}`,
    );
  }
  return OK;
}
