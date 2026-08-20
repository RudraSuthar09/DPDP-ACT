import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from './capability.service';

export const REQUIRE_CAPABILITY_KEY = 'dpdp:require-capability';

/**
 * Static per-route capability gate (locked architecture §10): the backend
 * enforcement half of the centralized capability model — frontend hiding is
 * UX only, this decorator + CapabilityGuard is the security boundary.
 *
 *   @RequireCapability('enterpriseGateway')
 *
 * For a requirement that depends on the REQUEST BODY rather than the
 * tenant's current state (e.g. "does this license entitle the requested
 * plan"), call `CapabilityService.assertCapability()` directly in the
 * service instead — this decorator is for the static case only.
 */
export const RequireCapability = (feature: FeatureKey) => SetMetadata(REQUIRE_CAPABILITY_KEY, feature);
