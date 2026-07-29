import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { DataFlowRepository } from './data-flow.repository';

/**
 * FR-INV-10: elements -> purposes -> recipients, as queryable linked data.
 * GET-only, so it needs no @Audited annotation (the interceptor only audits
 * mutations) — see DataFlowRepository's doc comment for the row shape.
 */
@Controller('inventory/data-flows')
@UseGuards(TenantGuard)
export class DataFlowController {
  constructor(private readonly dataFlow: DataFlowRepository) {}

  @Get()
  async list() {
    const rows = await this.dataFlow.listFlows();
    return {
      flows: rows.map((r) => ({
        entryId: r.entry_id,
        category: r.category,
        purposeId: r.purpose_id,
        purposeName: r.purpose_name,
        legalBasis: r.legal_basis,
        retentionPeriod: r.retention_period,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
      })),
    };
  }
}
