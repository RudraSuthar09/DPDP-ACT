import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { VendorsService } from './vendors.service';
import { parseVendorInput, parseTombstoneInput } from './vendors.dto';
import type { VendorRow, VendorVersionRow } from './vendors.repository';

/** FR-INV-07: the vendor/third-party processor register itself (not the link to an entry — see EntryVendorsController). */
@Controller('inventory/vendors')
@UseGuards(TenantGuard)
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Post()
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.vendor.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const fields = parseVendorInput(body);
    const { vendor, version } = await this.vendors.create(fields);
    return toDetailResponse(vendor, version);
  }

  @Get()
  async list(@Query('includeTombstoned') includeTombstoned?: string) {
    const rows = await this.vendors.list(includeTombstoned === 'true');
    return {
      vendors: rows.map((v) => ({
        id: v.id,
        status: v.status,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
        versionNumber: v.version_number,
        name: v.name,
        description: v.description,
        contactEmail: v.contact_email,
        dpaReference: v.dpa_reference,
        country: v.country,
      })),
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { vendor, versions, linkedEntries } = await this.vendors.findOne(id);
    return {
      id: vendor.id,
      status: vendor.status,
      tombstoneReason: vendor.tombstone_reason,
      tombstonedAt: vendor.tombstoned_at,
      createdAt: vendor.created_at,
      updatedAt: vendor.updated_at,
      versions: versions.map(toVersionResponse),
      linkedEntries: linkedEntries.map((e) => ({ linkId: e.linkId, entryId: e.entryId, category: e.category })),
    };
  }

  @Patch(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.vendor.updated')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const fields = parseVendorInput(body);
    const version = await this.vendors.update(id, fields);
    return toVersionResponse(version);
  }

  @Delete(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.vendor.tombstoned')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneInput(body);
    const vendor = await this.vendors.tombstone(id, reason);
    return { id: vendor.id, status: vendor.status, tombstonedAt: vendor.tombstoned_at };
  }
}

function toDetailResponse(vendor: VendorRow, version: VendorVersionRow) {
  return {
    ...toVersionResponse(version),
    id: vendor.id,
    status: vendor.status,
    createdAt: vendor.created_at,
    updatedAt: vendor.updated_at,
  };
}

function toVersionResponse(v: VendorVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.name,
    description: v.description,
    contactEmail: v.contact_email,
    dpaReference: v.dpa_reference,
    country: v.country,
    createdAt: v.created_at,
  };
}
