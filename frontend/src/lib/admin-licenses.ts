/**
 * Shared types and helpers for the internal admin portal (/admin/*). Talks to
 * the platform-admin API only (platformAdminFetch) — never the tenant API.
 * Licence keys never appear here: the API returns only key prefixes.
 */
import { platformAdminFetch } from './platform-admin-api';

export type Plan = 'saas' | 'enterprise';
export type DeploymentType = 'hosted' | 'client_server';
export type LicenseStatus = 'pending' | 'active' | 'expired' | 'revoked';

export interface LicenseView {
  id: string;
  plan: Plan;
  deploymentType: DeploymentType;
  licenseKeyPrefix: string;
  status: LicenseStatus;
  issuedAt: string;
  expiresAt: string | null;
  activatedAt: string | null;
  issuedBy: 'tenant_owner' | 'platform_admin';
  /** Platform-admin approval gate — null until approved. */
  approvedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface AdminLicenseView extends LicenseView {
  tenantId: string;
  organisationName: string;
  ownerEmail: string | null;
}

export interface OrganisationSummary {
  id: string;
  name: string;
  plan: Plan;
  deploymentType: DeploymentType;
  ownerEmail: string | null;
  createdAt: string;
}

/**
 * The portal's lifecycle buckets, derived from existing columns only (no
 * `rejected` status exists in the database):
 *   pending_approval  pending, never approved
 *   approved          pending, approved, not yet activated by the customer
 *   active            active and not past expiry
 *   expired           status expired, or past expires_at (an active licence
 *                     stays `active` in storage after expiry — see the backend)
 *   rejected          revoked without ever being approved
 *   revoked           revoked after approval
 */
export type LicenseBucket = 'pending_approval' | 'approved' | 'active' | 'expired' | 'rejected' | 'revoked';

export function licenseBucket(l: LicenseView, now: Date = new Date()): LicenseBucket {
  if (l.status === 'revoked') return l.approvedAt ? 'revoked' : 'rejected';
  const pastExpiry = l.expiresAt !== null && new Date(l.expiresAt).getTime() <= now.getTime();
  if (l.status === 'expired' || pastExpiry) return 'expired';
  if (l.status === 'active') return 'active';
  return l.approvedAt ? 'approved' : 'pending_approval';
}

export const BUCKET_LABEL: Record<LicenseBucket, string> = {
  pending_approval: 'Pending approval',
  approved: 'Approved — awaiting activation',
  active: 'Active',
  expired: 'Expired',
  rejected: 'Rejected',
  revoked: 'Revoked',
};

export const BUCKET_BADGE: Record<LicenseBucket, string> = {
  pending_approval: 'badge info',
  approved: 'badge neutral',
  active: 'badge success',
  expired: 'badge warning',
  rejected: 'badge denied',
  revoked: 'badge denied',
};

export const PLAN_LABEL: Record<string, string> = { saas: 'SaaS', enterprise: 'Enterprise' };
export const DEPLOYMENT_LABEL: Record<string, string> = { hosted: 'Hosted', client_server: 'Client server' };

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function approveLicense(tenantId: string, licenseId: string): Promise<unknown> {
  return platformAdminFetch(`/platform-admin/organisations/${tenantId}/licenses/${licenseId}/approve`, { method: 'POST' });
}

export function rejectLicense(tenantId: string, licenseId: string, reason: string): Promise<unknown> {
  return platformAdminFetch(`/platform-admin/organisations/${tenantId}/licenses/${licenseId}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

export async function fetchAllLicenses(): Promise<AdminLicenseView[]> {
  return (await platformAdminFetch<{ licenses: AdminLicenseView[] }>('/platform-admin/licenses')).licenses;
}

export async function fetchOrganisations(): Promise<OrganisationSummary[]> {
  return (await platformAdminFetch<{ organisations: OrganisationSummary[] }>('/platform-admin/organisations')).organisations;
}
