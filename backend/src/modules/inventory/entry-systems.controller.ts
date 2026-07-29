import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { SystemsService } from './systems.service';
import { parseSystemLinkInput, parseTombstoneInput } from './systems.dto';

/**
 * The link from a Data Inventory register entry to a system it lives on
 * (FR-INV-06/10). Separate controller from RegisterController and
 * SystemsController but the same base path as EntryPurposesController —
 * see that controller's doc comment for why the route shapes don't collide.
 */
@Controller('inventory/register')
@UseGuards(TenantGuard)
export class EntrySystemsController {
  constructor(private readonly systems: SystemsService) {}

  @Post(':entryId/systems')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_system_link.created')
  @HttpCode(HttpStatus.CREATED)
  async link(@Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    const { systemId } = parseSystemLinkInput(body);
    const link = await this.systems.link(entryId, systemId);
    return { id: link.id, entryId: link.entry_id, systemId: link.system_id, status: link.status };
  }

  @Get(':entryId/systems')
  async list(@Param('entryId', ParseUUIDPipe) entryId: string) {
    const rows = await this.systems.listForEntry(entryId);
    return {
      systems: rows.map((s) => ({
        linkId: s.linkId,
        id: s.id,
        name: s.name,
        systemType: s.system_type,
        description: s.description,
        hostingLocation: s.hosting_location,
      })),
    };
  }

  @Delete('systems/links/:linkId')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_system_link.removed')
  @HttpCode(HttpStatus.OK)
  async unlink(@Param('linkId', ParseUUIDPipe) linkId: string, @Body() body: unknown) {
    const { reason } = parseTombstoneInput(body);
    const link = await this.systems.unlink(linkId, reason);
    return { id: link.id, status: link.status };
  }
}
