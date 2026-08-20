import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { LicensingService } from '../licensing/licensing.service';
import { CapabilityService, type CapabilityView } from '../capability/capability.service';
import { InstallationRepository, type InstallationRow } from './installation.repository';
import type { RegisterInstallationInput } from './installation.dto';

export interface InstallationView {
  id: string;
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  version: string;
  status: 'active' | 'inactive' | 'decommissioned';
  environmentMetadata: Record<string, unknown>;
  registeredAt: string;
  lastHeartbeatAt: string | null;
}

/**
 * Installation registration (locked architecture §11/§9): "Install DPDP ->
 * Enter License Key -> Central Control Plane -> Validate License -> Register
 * Installation -> Activate Correct Deployment Capabilities". The license/
 * deploymentType match check IS the server-side license validation this
 * flow requires — the frontend never decides whether a license is valid.
 * Tenant-scoped throughout (TenantGuard + RLS); an installation can never be
 * registered outside the caller's own tenant context.
 */
@Injectable()
export class InstallationService {
  constructor(
    private readonly repo: InstallationRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    private readonly licensing: LicensingService,
    private readonly capability: CapabilityService,
  ) {}

  async register(input: RegisterInstallationInput): Promise<{ installation: InstallationView; capabilities: CapabilityView }> {
    const ctx = this.tenantContext.getOrThrow();

    // Server-side license validation (never trust the caller's own claim).
    const license = await this.licensing.resolveAndValidate(input.licenseKey, {
      plan: input.plan,
      deploymentType: input.deploymentType,
    });

    const row = await this.repo.create({
      plan: input.plan,
      deploymentType: input.deploymentType,
      version: input.version,
      environmentMetadata: input.environmentMetadata,
      registeredBy: ctx.userId,
    });

    await this.licensing.activate(license.id, row.id);

    this.audit.annotate({
      targetType: 'installation',
      targetId: row.id,
      reason: `Installation registered (${row.plan}/${row.deployment_type}, version ${row.version}).`,
      afterState: { plan: row.plan, deploymentType: row.deployment_type, version: row.version, status: row.status },
    });

    const capabilities = await this.capability.resolve();
    return { installation: toView(row), capabilities };
  }

  async getActive(): Promise<InstallationView | null> {
    const row = await this.repo.findActive();
    return row ? toView(row) : null;
  }

  async touchHeartbeat(id: string, version: string): Promise<InstallationRow | null> {
    return this.repo.touchHeartbeat(id, version);
  }

  async getById(id: string): Promise<InstallationView> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('Installation not found.');
    return toView(row);
  }
}

function toView(row: InstallationRow): InstallationView {
  return {
    id: row.id,
    plan: row.plan,
    deploymentType: row.deployment_type,
    version: row.version,
    status: row.status,
    environmentMetadata: row.environment_metadata,
    registeredAt: row.registered_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at ? row.last_heartbeat_at.toISOString() : null,
  };
}
