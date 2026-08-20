import { BadRequestException } from '@nestjs/common';

/** Request parsing for the installation module — hand-written and total,
 *  same style as gateway.dto.ts / licensing.dto.ts. */

const PLANS = ['saas', 'enterprise'] as const;
const DEPLOYMENT_TYPES = ['hosted', 'client_server'] as const;
type Plan = (typeof PLANS)[number];
type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

/** Same forbidden-secret-field discipline as gateway.dto.ts: an installation
 *  never sends a credential/secret to the control plane. */
const FORBIDDEN_SECRET_FIELDS = ['privateKey', 'private_key', 'secretKey', 'secret_key', 'secret', 'password', 'connectionString', 'connection_string', 'dsn'];

function rejectSecretFields(obj: Record<string, unknown>): void {
  for (const field of FORBIDDEN_SECRET_FIELDS) {
    if (field in obj) {
      throw new BadRequestException(`Installation registration never accepts "${field}" — no credential/secret leaves the client environment.`);
    }
  }
}

export interface RegisterInstallationInput {
  licenseKey: string;
  plan: Plan;
  deploymentType: DeploymentType;
  version: string;
  environmentMetadata: Record<string, unknown>;
}

export function parseRegisterInstallation(body: unknown): RegisterInstallationInput {
  const obj = asObject(body);
  rejectSecretFields(obj);

  const licenseKey = obj['licenseKey'];
  if (typeof licenseKey !== 'string' || licenseKey.trim().length < 8) {
    throw new BadRequestException('licenseKey is required.');
  }

  const plan = obj['plan'];
  if (typeof plan !== 'string' || !(PLANS as readonly string[]).includes(plan)) {
    throw new BadRequestException(`plan must be one of: ${PLANS.join(', ')}.`);
  }
  const deploymentType = obj['deploymentType'];
  if (typeof deploymentType !== 'string' || !(DEPLOYMENT_TYPES as readonly string[]).includes(deploymentType)) {
    throw new BadRequestException(`deploymentType must be one of: ${DEPLOYMENT_TYPES.join(', ')}.`);
  }

  const version = obj['version'];
  if (typeof version !== 'string' || version.trim().length === 0 || version.trim().length > 64) {
    throw new BadRequestException('version is required.');
  }

  const environmentMetadataRaw = obj['environmentMetadata'];
  if (environmentMetadataRaw !== undefined && (typeof environmentMetadataRaw !== 'object' || environmentMetadataRaw === null || Array.isArray(environmentMetadataRaw))) {
    throw new BadRequestException('environmentMetadata must be an object.');
  }
  if (environmentMetadataRaw && typeof environmentMetadataRaw === 'object') {
    rejectSecretFields(environmentMetadataRaw as Record<string, unknown>);
  }

  return {
    licenseKey: licenseKey.trim(),
    plan: plan as Plan,
    deploymentType: deploymentType as DeploymentType,
    version: version.trim(),
    environmentMetadata: (environmentMetadataRaw as Record<string, unknown> | undefined) ?? {},
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}
