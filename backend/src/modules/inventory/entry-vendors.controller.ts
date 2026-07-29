import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { VendorsService } from './vendors.service';
import { parseVendorLinkInput, parseTombstoneInput } from './vendors.dto';

/**
 * The link from a Data Inventory register entry to a vendor who receives it
 * (FR-INV-07/10 — the "recipient" in elements -> purposes -> recipients).
 * Same base path as EntryPurposesController/EntrySystemsController — see
 * EntryPurposesController's doc comment for why the route shapes don't collide.
 */
@Controller('inventory/register')
@UseGuards(TenantGuard)
export class EntryVendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Post(':entryId/vendors')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_vendor_link.created')
  @HttpCode(HttpStatus.CREATED)
  async link(@Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    const { vendorId, transferNotes } = parseVendorLinkInput(body);
    const link = await this.vendors.link(entryId, vendorId, transferNotes);
    return {
      id: link.id,
      entryId: link.entry_id,
      vendorId: link.vendor_id,
      transferNotes: link.transfer_notes,
      status: link.status,
    };
  }

  @Get(':entryId/vendors')
  async list(@Param('entryId', ParseUUIDPipe) entryId: string) {
    const rows = await this.vendors.listForEntry(entryId);
    return {
      vendors: rows.map((v) => ({
        linkId: v.linkId,
        id: v.id,
        name: v.name,
        description: v.description,
        contactEmail: v.contact_email,
        dpaReference: v.dpa_reference,
        country: v.country,
        transferNotes: v.transferNotes,
      })),
    };
  }

  @Delete('vendors/links/:linkId')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_vendor_link.removed')
  @HttpCode(HttpStatus.OK)
  async unlink(@Param('linkId', ParseUUIDPipe) linkId: string, @Body() body: unknown) {
    const { reason } = parseTombstoneInput(body);
    const link = await this.vendors.unlink(linkId, reason);
    return { id: link.id, status: link.status };
  }
}
