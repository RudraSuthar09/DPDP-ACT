import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { DataSourceService } from './data-source.service';
import {
  parseCreateDataSource,
  parseModeToggle,
  parseRawAccess,
  parseTombstoneReason,
  parseUpdateDataSource,
} from './data-source.dto';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Staff management of data-source METADATA and per-source access mode (I1/§2.1).
 *
 * ===========================================================================
 * THERE IS NO RAW-DATA ROUTE HERE, AND THERE MUST NEVER BE ONE.
 *
 * No GET /:id/rows, no GET /:id/data, no /:id/read, no /customer-records — this
 * controller reads and writes METADATA only. A source's access mode is
 * configuration; setting it to gateway_connected grants no raw access, because
 * no Gateway/connector/raw-read capability exists (Phase 1, fail closed). The
 * raw-access guard test asserts the absence of any such route/method.
 * ===========================================================================
 */
@Controller('data-sources')
@UseGuards(TenantGuard)
export class DataSourceController {
  constructor(private readonly sources: DataSourceService) {}

  @Get()
  async list(@Query('includeTombstoned') includeTombstoned?: string) {
    return { sources: await this.sources.list(includeTombstoned === 'true') };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.sources.get(id);
  }

  @Post()
  @Roles(...MANAGE)
  @Audited('datasource.source.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    return this.sources.create(parseCreateDataSource(body));
  }

  @Put(':id')
  @Roles(...MANAGE)
  @Audited('datasource.source.updated')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return this.sources.update(id, parseUpdateDataSource(body));
  }

  /** The explicit, privileged Mode toggle (metadata_only <-> gateway_connected).
   *  Enabling grants NO raw access in Phase 1 — it is a configuration state. */
  @Patch(':id/mode')
  @Roles(...MANAGE)
  @Audited('datasource.source.mode_changed')
  async setMode(@Param('id') id: string, @Body() body: unknown) {
    const { enabled } = parseModeToggle(body);
    return this.sources.setMode(id, enabled);
  }

  /**
   * Record + authorize a Mode-B raw-data VIEW (metadata only). This is the ONLY
   * backend interaction the raw viewer makes. It accepts a row COUNT and nothing
   * else — no file, no rows, no multipart. It fails closed if the source is not
   * an active gateway_connected source. The parsing and display happen entirely
   * in the user's browser; the file/rows never reach this server (Phase 2 / I1).
   */
  @Post(':id/raw-access')
  @Roles(...MANAGE)
  @Audited('datasource.raw_access.viewed')
  @HttpCode(HttpStatus.OK)
  async recordRawAccess(@Param('id') id: string, @Body() body: unknown) {
    const { rowCount } = parseRawAccess(body);
    return this.sources.recordRawAccess(id, rowCount);
  }

  /** Soft-delete (tombstone) — there is no hard delete (I4). */
  @Delete(':id')
  @Roles(...MANAGE)
  @Audited('datasource.source.removed')
  async remove(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneReason(body);
    return this.sources.remove(id, reason);
  }
}
