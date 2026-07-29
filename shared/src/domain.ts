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
  /**
   * True when the request reached a tenant WITHOUT any actor behind it — the
   * public request portal, where a member of the public files a grievance with
   * no login (FR-GRV-01). The tenant is real and fully RLS-bound; the person is
   * unknown and must stay that way.
   *
   * It exists because `userId` is a `string` that ~35 call sites pass straight
   * into a `created_by`/`set_by` column, and widening it to `string | null`
   * everywhere would trade one honest flag for thirty nullable columns. Instead
   * anonymous contexts carry the nil UUID (see ANONYMOUS_TENANT_USER_ID) — a
   * value that satisfies the type and violates the FK, so anything that DID try
   * to write it as an actor fails loudly rather than attributing a public
   * submission to a person who does not exist.
   *
   * The one place that must honour it is the audit interceptor, which writes
   * `actor_id = NULL` + an anonymous actor label instead of `ctx.userId`.
   */
  anonymous?: boolean;
}

/**
 * The `userId` an anonymous (public portal) tenant context carries. The nil
 * UUID: never a real user, and guaranteed to fail `REFERENCES users (id)` if it
 * ever reaches a column that expects an actor. See `TenantContext.anonymous`.
 */
export const ANONYMOUS_TENANT_USER_ID = '00000000-0000-0000-0000-000000000000';
