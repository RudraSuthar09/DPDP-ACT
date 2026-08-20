import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { CapabilityService } from './capability.service';

/**
 * GET /capabilities — the one place the frontend reads plan/deploymentType/
 * features from (locked architecture §10). Any authenticated tenant user may
 * read their own tenant's capabilities; this is a read, not a grant — the
 * actual enforcement is CapabilityGuard/assertCapability on the routes that
 * matter.
 */
@Controller('capabilities')
@UseGuards(TenantGuard)
export class CapabilityController {
  constructor(private readonly capability: CapabilityService) {}

  @Get()
  async get() {
    return this.capability.resolve();
  }
}
