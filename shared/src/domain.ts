/** The five product modules plus the cross-cutting backend modules. */
export const MODULES = [
  'identity',
  'inventory',
  'consent',
  'breach',
  'grievance',
  'dprequest',
  'audit',
  'notify',
] as const;
export type ModuleName = (typeof MODULES)[number];

/**
 * The five PRODUCT module areas. Every tenant workspace is provisioned with all
 * five at sign-up (FR-IDN-01) — see the `workspace_modules` table. The
 * cross-cutting modules (identity/audit/notify) are platform machinery, not
 * workspace areas, so they are deliberately not here.
 */
export const MODULE_AREAS = ['inventory', 'consent', 'breach', 'grievance', 'dprequest'] as const;
export type ModuleArea = (typeof MODULE_AREAS)[number];

/**
 * RBAC roles (FR-IDN-03). Basic in Stage 1; granular enforcement in Stage 2.
 * A runtime array (not just a type) because roles must be validated against
 * untrusted input at the edge, and a type erases at compile time.
 * Mirrored by the CHECK constraint on `users.role` — the DB is the enforcement.
 */
export const ROLES = [
  'owner',
  'dpo',
  'compliance_officer',
  'grievance_officer',
  'auditor', // read-only
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Roles that may never mutate anything, anywhere (FR-IDN-03: "Auditor
 * (read-only)"). Enforced centrally by RolesGuard rather than by remembering to
 * annotate every mutating handler — the safe default is the one you get for free.
 */
export const READ_ONLY_ROLES: readonly Role[] = ['auditor', 'viewer'];

export function isReadOnlyRole(role: Role): boolean {
  return READ_ONLY_ROLES.includes(role);
}

/**
 * User lifecycle (FR-IDN-05). Users are NEVER hard-deleted — platform-wide rule,
 * and invariant I4. `removed` is a tombstone: the row and its audit trail stay
 * forever; only the ability to authenticate goes away.
 */
export const USER_STATUSES = ['active', 'suspended', 'removed'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Multi-tenancy tiers (§4.4). Stage 1 ships Standard only; tier is a
 * deployment/routing concern, never an application-code concern. */
export type TenantTier = 'standard' | 'premium' | 'enterprise';

/** Data Principal rights-request types (FR-DPR-01, DPDP Act §§11–14). */
export type DPRequestType =
  'access' | 'correction' | 'erasure' | 'nomination' | 'portability' | 'withdraw_consent';

/** Shared ticket/workflow lifecycle for Breach, Grievance, and DPRequest. */
export type WorkflowStatus =
  'open' | 'verifying' | 'in_progress' | 'escalated' | 'awaiting_client' | 'resolved' | 'closed';

/**
 * Tenant context propagated from JWT → async-local context → Postgres session
 * GUC (Seam S1). There is no code path where tenant is optional.
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  correlationId: string;
}
