import { SetMetadata } from '@nestjs/common';
import type { Role } from '@dpdp/shared';

export const ROLES_KEY = 'dpdp:roles';
export const ALLOW_READ_ONLY_KEY = 'dpdp:allow-read-only';
export const ALLOW_PUBLIC_KEY_KEY = 'dpdp:allow-public-key';

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

/**
 * Exempt a route from the "read-only roles may not mutate" floor for a
 * DIFFERENT reason than @AllowReadOnly — this is NOT a claim that the route
 * doesn't mutate. The two Consent SDK public routes (PublicApiKeyMiddleware)
 * genuinely write to the consent event log. They carry a synthetic
 * `TenantContext.role: 'viewer'` purely because a request authenticated by a
 * public API key has no human RBAC role to put there, and `Role` has no
 * dedicated literal for "authenticated by API key" — 'viewer' is just the
 * value that satisfies the type. 'viewer' happens to be one of
 * READ_ONLY_ROLES, so without this decorator the floor would reject every
 * write the SDK makes.
 *
 * Kept separate from @AllowReadOnly on purpose: that decorator's own doc
 * comment says "this POST changes nothing," which would be false here, and a
 * future reader (or a future route copy-pasting an existing example) should
 * never be able to infer "this route is safe/non-mutating" from seeing it
 * used. If it isn't obvious why a route needs this, it very likely shouldn't
 * have it — the honest fix for a genuinely new API-key role is adding one to
 * shared/src/domain.ts, not stretching this further.
 */
export const AllowPublicKey = () => SetMetadata(ALLOW_PUBLIC_KEY_KEY, true);
