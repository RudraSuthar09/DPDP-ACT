import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { DataSourceService } from './data-source.service';
import {
  parseCreateDataSource,
  parseCustomerWriteConfig,
  parseGatewayEvent,
  parseIdentityColumn,
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

  /**
   * Phase 3G-1: explicit customer-identity column configuration. Records which
   * EXISTING column the client says identifies a customer — a column NAME, never
   * a value, never assumed. Does NOT perform a lookup (that is Phase 3G-2).
   */
  @Patch(':id/identity-column')
  @Roles(...MANAGE)
  @Audited('datasource.source.identity_column_set')
  async setIdentityColumn(@Param('id') id: string, @Body() body: unknown) {
    const { identityColumn } = parseIdentityColumn(body);
    return this.sources.setIdentityColumn(id, identityColumn);
  }

  /**
   * Phase 3H-1: the CENTRAL customer-write configuration — whether creation is
   * allowed and which column NAMES are writable. Column names only, never
   * values; never auto-populated from discovered columns. This is the
   * platform's own source of truth, consulted by staff-assisted flows before
   * even attempting a write — the Gateway agent's own local config remains a
   * separate, independently-enforced check (defence in depth).
   */
  @Patch(':id/customer-write-config')
  @Roles(...MANAGE)
  @Audited('datasource.source.customer_write_config_set')
  async setCustomerWriteConfig(@Param('id') id: string, @Body() body: unknown) {
    const { allowCustomerCreate, writableColumns } = parseCustomerWriteConfig(body);
    return this.sources.setCustomerWriteConfig(id, allowCustomerCreate, writableColumns);
  }

  /**
   * Phase 3G-2: record a Gateway customer/column event — METADATA ONLY, a
   * post-hoc fact ("this happened"). The actual customer resolve/write/create
   * or column-create operation runs entirely between the browser and the
   * Gateway, over the local/LAN Gateway connection; it never touches this
   * server. `@Audited` names the fallback action — the service always
   * overrides it with the caller's allowlisted `action` (parseGatewayEvent
   * rejects anything else), so the hash-chain entry gets the precise name.
   */
  @Post(':id/gateway-events')
  @Roles(...MANAGE)
  @Audited('gateway.customer_field.event')
  @HttpCode(HttpStatus.OK)
  async recordGatewayEvent(@Param('id') id: string, @Body() body: unknown) {
    const { action, rowCount } = parseGatewayEvent(body);
    return this.sources.recordGatewayEvent(id, action, rowCount);
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
