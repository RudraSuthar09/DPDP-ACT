import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CapabilityService, type FeatureKey } from './capability.service';
import { REQUIRE_CAPABILITY_KEY } from './capability.decorator';

/**
 * Route-level enforcement of `@RequireCapability(...)`. Thin wrapper over
 * `CapabilityService.assertCapability()` — the one enforcement primitive — so
 * the static (route) and dynamic (service-called) enforcement paths can never
 * drift apart into two different notions of "does this tenant have X".
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly capability: CapabilityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRE_CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;
    const { features } = await this.capability.resolve();
    if (!features[feature]) {
      throw new ForbiddenException(`This tenant's current plan/license does not entitle "${feature}".`);
    }
    return true;
  }
}
