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
import { EntryPurposesService } from './entry-purposes.service';
import { parseEntryPurposeInput, parsePurposeTombstoneInput } from './entry-purposes.dto';
import type { EntryPurposeRow, EntryPurposeVersionRow } from './entry-purposes.repository';

/**
 * FR-INV-05: processing purposes + legal basis + retention, one-to-many
 * against a Data Inventory register entry. Nested under /inventory/register
 * so a purpose is always reached in the context of its entry, except for
 * update/tombstone/detail which only need the purpose's own id (a purpose
 * id is already globally unique — RLS still confines it to the caller's
 * tenant). See entry-purposes.service.ts for `/purposes/:id` not colliding
 * with RegisterController's `:id` route: the segment shapes differ.
 */
@Controller('inventory/register')
@UseGuards(TenantGuard)
export class EntryPurposesController {
  constructor(private readonly purposes: EntryPurposesService) {}

  @Post(':entryId/purposes')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_purpose.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    const fields = parseEntryPurposeInput(body);
    const { purpose, version } = await this.purposes.create(entryId, fields);
    return toDetailResponse(purpose, version);
  }

  @Get(':entryId/purposes')
  async list(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Query('includeTombstoned') includeTombstoned?: string,
  ) {
    const rows = await this.purposes.listForEntry(entryId, includeTombstoned === 'true');
    return {
      purposes: rows.map((p) => ({
        id: p.id,
        entryId: p.entry_id,
        status: p.status,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        versionNumber: p.version_number,
        purposeName: p.purpose_name,
        description: p.description,
        legalBasis: p.legal_basis,
        legalBasisNote: p.legal_basis_note,
        retentionPeriod: p.retention_period,
        retentionMonths: p.retention_months,
      })),
    };
  }

  /** One purpose, with its full version history. */
  @Get('purposes/:id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { purpose, versions } = await this.purposes.findOne(id);
    return {
      id: purpose.id,
      entryId: purpose.entry_id,
      status: purpose.status,
      tombstoneReason: purpose.tombstone_reason,
      tombstonedAt: purpose.tombstoned_at,
      createdAt: purpose.created_at,
      updatedAt: purpose.updated_at,
      versions: versions.map(toVersionResponse),
    };
  }

  /** Edit. Creates a new version — nothing is ever overwritten. */
  @Patch('purposes/:id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_purpose.updated')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const fields = parseEntryPurposeInput(body);
    const version = await this.purposes.update(id, fields);
    return toVersionResponse(version);
  }

  /** Soft-delete. Never a hard delete (I4). */
  @Delete('purposes/:id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.entry_purpose.tombstoned')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parsePurposeTombstoneInput(body);
    const purpose = await this.purposes.tombstone(id, reason);
    return { id: purpose.id, status: purpose.status, tombstonedAt: purpose.tombstoned_at };
  }
}

function toDetailResponse(purpose: EntryPurposeRow, version: EntryPurposeVersionRow) {
  return {
    ...toVersionResponse(version),
    id: purpose.id,
    entryId: purpose.entry_id,
    status: purpose.status,
    createdAt: purpose.created_at,
    updatedAt: purpose.updated_at,
  };
}

function toVersionResponse(v: EntryPurposeVersionRow) {
  return {
    versionNumber: v.version_number,
    purposeName: v.purpose_name,
    description: v.description,
    legalBasis: v.legal_basis,
    legalBasisNote: v.legal_basis_note,
    retentionPeriod: v.retention_period,
    retentionMonths: v.retention_months,
    createdAt: v.created_at,
  };
}
