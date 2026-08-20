import { BadRequestException } from '@nestjs/common';

/** Request parsing for the licensing module — hand-written and total, same
 *  style as gateway.dto.ts / data-source.dto.ts. */

const PLANS = ['saas', 'enterprise'] as const;
const DEPLOYMENT_TYPES = ['hosted', 'client_server'] as const;
type Plan = (typeof PLANS)[number];
type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

export interface IssueLicenseInput {
  plan: Plan;
  deploymentType: DeploymentType;
  features: Record<string, unknown>;
  expiresAt: Date | null;
}

export function parseIssueLicense(body: unknown): IssueLicenseInput {
  const obj = asObject(body);
  const plan = obj['plan'];
  if (typeof plan !== 'string' || !(PLANS as readonly string[]).includes(plan)) {
    throw new BadRequestException(`plan must be one of: ${PLANS.join(', ')}.`);
  }
  const deploymentType = obj['deploymentType'];
  if (typeof deploymentType !== 'string' || !(DEPLOYMENT_TYPES as readonly string[]).includes(deploymentType)) {
    throw new BadRequestException(`deploymentType must be one of: ${DEPLOYMENT_TYPES.join(', ')}.`);
  }
  const featuresRaw = obj['features'];
  if (featuresRaw !== undefined && (typeof featuresRaw !== 'object' || featuresRaw === null || Array.isArray(featuresRaw))) {
    throw new BadRequestException('features must be an object.');
  }
  const expiresAtRaw = obj['expiresAt'];
  let expiresAt: Date | null = null;
  if (expiresAtRaw !== undefined && expiresAtRaw !== null) {
    if (typeof expiresAtRaw !== 'string') throw new BadRequestException('expiresAt must be an ISO date string or null.');
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException('expiresAt must be a valid ISO date string.');
    expiresAt = parsed;
  }
  return {
    plan: plan as Plan,
    deploymentType: deploymentType as DeploymentType,
    features: (featuresRaw as Record<string, unknown> | undefined) ?? {},
    expiresAt,
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}
