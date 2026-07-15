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

/** RBAC roles (FR-IDN-03). Basic in Stage 1; granular enforcement in Stage 2. */
export type Role =
  | 'owner'
  | 'dpo'
  | 'compliance_officer'
  | 'grievance_officer'
  | 'auditor' // read-only
  | 'viewer';

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
