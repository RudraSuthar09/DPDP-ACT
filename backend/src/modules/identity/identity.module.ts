import { Module } from '@nestjs/common';

/**
 * Identity & Tenancy. Owns tenant provisioning, auth (email + password + MFA),
 * RBAC, and — critically — tenant-context propagation into the Postgres session
 * GUC (Seam S1). Every other module depends on the tenant context this sets.
 *
 * Requirements: FR-IDN-01/02/03/04/05.  Seams: S1.  Invariants: I3.
 * Skeleton only — no providers or controllers yet.
 */
@Module({})
export class IdentityModule {}
