import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { SectorTemplatesService } from './sector-templates.service';

/**
 * FR-INV-11: sector templates (healthcare, retail, edtech, fintech) that
 * pre-seed common data elements. The catalog is global and read-only
 * (@Roles is intentionally NOT applied to the GET routes — every role may
 * browse the catalog); applying one is a tenant-scoped write restricted the
 * same as any other register mutation.
 */
@Controller('inventory/sector-templates')
@UseGuards(TenantGuard)
export class SectorTemplatesController {
  constructor(private readonly templates: SectorTemplatesService) {}

  @Get()
  async list() {
    const rows = await this.templates.list();
    return {
      templates: rows.map((t) => ({
        id: t.id,
        sector: t.sector,
        name: t.name,
        elementCount: t.elementCount,
      })),
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { template, version } = await this.templates.findOne(id);
    return {
      id: template.id,
      sector: template.sector,
      name: template.name,
      elements: version.elements,
    };
  }

  @Post(':id/apply')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.sector_template.applied')
  @HttpCode(HttpStatus.CREATED)
  async apply(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.apply(id);
  }
}
