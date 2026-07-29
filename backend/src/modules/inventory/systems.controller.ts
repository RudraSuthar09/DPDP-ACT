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
import { SystemsService } from './systems.service';
import { parseSystemInput, parseTombstoneInput } from './systems.dto';
import type { SystemRow, SystemVersionRow } from './systems.repository';

/** FR-INV-06: the systems/assets register itself (not the link to an entry — see EntrySystemsController). */
@Controller('inventory/systems')
@UseGuards(TenantGuard)
export class SystemsController {
  constructor(private readonly systems: SystemsService) {}

  @Post()
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.system.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const fields = parseSystemInput(body);
    const { system, version } = await this.systems.create(fields);
    return toDetailResponse(system, version);
  }

  @Get()
  async list(@Query('includeTombstoned') includeTombstoned?: string) {
    const rows = await this.systems.list(includeTombstoned === 'true');
    return {
      systems: rows.map((s) => ({
        id: s.id,
        status: s.status,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        versionNumber: s.version_number,
        name: s.name,
        systemType: s.system_type,
        description: s.description,
        hostingLocation: s.hosting_location,
      })),
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { system, versions, linkedEntries } = await this.systems.findOne(id);
    return {
      id: system.id,
      status: system.status,
      tombstoneReason: system.tombstone_reason,
      tombstonedAt: system.tombstoned_at,
      createdAt: system.created_at,
      updatedAt: system.updated_at,
      versions: versions.map(toVersionResponse),
      linkedEntries: linkedEntries.map((e) => ({ linkId: e.linkId, entryId: e.entryId, category: e.category })),
    };
  }

  @Patch(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.system.updated')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const fields = parseSystemInput(body);
    const version = await this.systems.update(id, fields);
    return toVersionResponse(version);
  }

  @Delete(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.system.tombstoned')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneInput(body);
    const system = await this.systems.tombstone(id, reason);
    return { id: system.id, status: system.status, tombstonedAt: system.tombstoned_at };
  }
}

function toDetailResponse(system: SystemRow, version: SystemVersionRow) {
  return {
    ...toVersionResponse(version),
    id: system.id,
    status: system.status,
    createdAt: system.created_at,
    updatedAt: system.updated_at,
  };
}

function toVersionResponse(v: SystemVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.name,
    systemType: v.system_type,
    description: v.description,
    hostingLocation: v.hosting_location,
    createdAt: v.created_at,
  };
}
