import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LicensingService } from '../licensing/licensing.service';
import { CapabilityRepository } from './capability.repository';
import { deriveFeatureDefaults, applyFeatureOverrides, type FeatureKey } from './capability-policy';

export type { FeatureKey } from './capability-policy';

/**
 * The ONE centralized capability model (locked architecture §10). Nowhere
 * else in the backend or frontend should branch on `plan`/`deploymentType`
 * directly — everything goes through `resolve()`/`assertCapability()`, so a
 * future feature gate is a features-map entry here, not a scattered
 * `if (plan === 'enterprise')`. The actual derivation is a pure function
 * (capability-policy.ts); this service's job is only to fetch the inputs.
 *
 * Falls back to organisations.plan/deployment_type (today's descriptive-only
 * columns) when the tenant holds no active license, so every existing dev/
 * demo tenant keeps working exactly as before (no backward-compat break) —
 * an active license, when present, is what actually entitles Enterprise-only
 * capabilities like `enterpriseGateway`.
 */

export interface CapabilityView {
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  features: Record<FeatureKey, boolean>;
}

@Injectable()
export class CapabilityService {
  constructor(
    private readonly repo: CapabilityRepository,
    private readonly licensing: LicensingService,
  ) {}

  async resolve(): Promise<CapabilityView> {
    const license = await this.licensing.findActiveForTenant();

    let plan: 'saas' | 'enterprise';
    let deploymentType: 'hosted' | 'client_server';
    let overrides: Record<string, unknown> = {};

    if (license) {
      plan = license.plan;
      deploymentType = license.deployment_type;
      overrides = license.features ?? {};
    } else {
      const orgDefaults = await this.repo.getOrganisationDefaults();
      if (!orgDefaults) throw new NotFoundException('Organisation not found.');
      plan = orgDefaults.plan;
      deploymentType = orgDefaults.deploymentType;
    }

    const features = applyFeatureOverrides(deriveFeatureDefaults(plan, deploymentType), overrides);
    return { plan, deploymentType, features };
  }

  /**
   * The one enforcement primitive. `CapabilityGuard` is sugar over this for
   * static per-route gating; services call it directly when the requirement
   * is data-dependent (e.g. GatewayService gating a link to a specific,
   * not-necessarily-current, target installation). Throws 403 — never
   * silently no-ops.
   */
  async assertCapability(feature: FeatureKey): Promise<void> {
    const { features } = await this.resolve();
    if (!features[feature]) {
      throw new ForbiddenException(`This tenant's current plan/license does not entitle "${feature}".`);
    }
  }
}
