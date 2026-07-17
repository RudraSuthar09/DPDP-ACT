import { SetMetadata } from '@nestjs/common';
import type { Role } from '@dpdp/shared';

export const ROLES_KEY = 'dpdp:roles';
export const ALLOW_READ_ONLY_KEY = 'dpdp:allow-read-only';

/**
 * Restrict a route to specific roles (FR-IDN-03).
 *
 *   @Roles('owner')                    — Owner only
 *   @Roles('owner', 'dpo')             — either
 *
 * Stage 1 is role gating and nothing more. Stage 2 makes this granular
 * (permissions per module area), and when it does, this decorator is where the
 * change lands — callers keep saying "who may do this", not "which permission
 * bit does this need".
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Exempt a route from the global "read-only roles may not mutate" rule.
 *
 * For the legitimate cases where a non-GET is not a mutation — a search that
 * takes a POST body too big for a query string, a report an Auditor asks the
 * platform to generate. Rare by design: every use is a place someone asserts
 * "this POST changes nothing", so it should be easy to find in review, which is
 * exactly why it is a named decorator and not a flag on @Roles.
 */
export const AllowReadOnly = () => SetMetadata(ALLOW_READ_ONLY_KEY, true);
