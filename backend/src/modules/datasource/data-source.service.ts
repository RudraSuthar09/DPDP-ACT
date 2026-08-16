import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSource } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { DataSourceRepository, type DataSourceRow } from './data-source.repository';
import type { CreateDataSourceInput, GatewayCustomerEventAction, UpdateDataSourceInput } from './data-source.dto';

/**
 * Managing data-source METADATA and its per-source access mode (I1/§2.1).
 *
 * There is no method here that reads a customer value — this service has no
 * capability to read the data behind a source, and the module has no such
 * capability at all (Phase 1). Enabling Mode B (`setMode(..., true)`) records a
 * CONFIGURATION STATE and grants no raw access: there is no Gateway/connector,
 * so any raw-data operation fails closed. See the raw-access guard test.
 *
 * Audit: every mutation is @Audited at the controller (the S5 interceptor writes
 * the hash-chain entry); this service annotates the domain detail — metadata
 * only, never a value or a secret.
 */
@Injectable()
export class DataSourceService {
  constructor(
    private readonly repo: DataSourceRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async create(input: CreateDataSourceInput): Promise<DataSource> {
    const ctx = this.tenantContext.getOrThrow();
    const row = await this.repo.create({
      name: input.name,
      sourceKind: input.sourceKind,
      connectionHint: input.connectionHint,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'data_source',
      targetId: row.id,
      reason: `Data source "${input.name}" (${input.sourceKind}) created in metadata_only mode.`,
      afterState: { sourceKind: input.sourceKind, dataAccessMode: row.data_access_mode },
    });
    return toResponse(row);
  }

  async list(includeTombstoned = false): Promise<DataSource[]> {
    const rows = await this.repo.list(includeTombstoned);
    return rows.map(toResponse);
  }

  async get(id: string): Promise<DataSource> {
    const row = await this.repo.findOne(id);
    if (!row) throw new NotFoundException('Data source not found.');
    return toResponse(row);
  }

  async update(id: string, input: UpdateDataSourceInput): Promise<DataSource> {
    const row = await this.repo.updateMetadata(id, input);
    if (!row) throw new NotFoundException('Data source not found or has been removed.');
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      reason: `Data source "${input.name}" metadata updated.`,
      afterState: { name: input.name },
    });
    return toResponse(row);
  }

  /**
   * The explicit, privileged Mode toggle. `enabled=true` sets gateway_connected
   * (a configuration state only — still no raw access in Phase 1); false returns
   * it to metadata_only. Audited as a security-sensitive change either way.
   */
  async setMode(id: string, enabled: boolean): Promise<DataSource> {
    const ctx = this.tenantContext.getOrThrow();
    const before = await this.repo.findOne(id);
    if (!before || before.status !== 'active') {
      throw new NotFoundException('Data source not found or has been removed.');
    }
    const mode = enabled ? 'gateway_connected' : 'metadata_only';
    const row = await this.repo.setMode(id, mode, ctx.userId);
    if (!row) throw new NotFoundException('Data source not found or has been removed.');
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      reason: enabled
        ? `Data source "${row.name}" access mode changed to gateway_connected (raw access is CONFIGURED but not yet available — no Gateway exists).`
        : `Data source "${row.name}" access mode changed to metadata_only.`,
      beforeState: { dataAccessMode: before.data_access_mode },
      afterState: { dataAccessMode: mode },
    });
    return toResponse(row);
  }

  /**
   * Record that an authorized Mode-B raw-data VIEW occurred, and confirm the
   * caller was allowed to do it. METADATA ONLY — it receives a row count, never
   * a value, and stores nothing but the audited fact of access.
   *
   * FAIL CLOSED: this is the server-authoritative gate. The source must exist,
   * be active, and be gateway_connected; otherwise it throws and no access is
   * authorized and nothing is audited as a view. The frontend reveals the parsed
   * rows ONLY after this resolves — so a metadata_only source (or a bypass
   * attempt) yields no reveal. It NEVER receives or persists the data itself;
   * an audit/authorization failure must never become a reason to upload data.
   */
  async recordRawAccess(id: string, rowCount: number): Promise<{ authorized: true }> {
    const row = await this.repo.findOne(id);
    if (!row || row.status !== 'active') {
      throw new NotFoundException('Data source not found or has been removed.');
    }
    if (row.data_access_mode !== 'gateway_connected') {
      throw new ForbiddenException(
        'This data source is metadata-only. Enable Gateway-connected mode before viewing raw data.',
      );
    }
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      // Metadata only: which source, its kind, and how many rows were viewed.
      // NEVER a value, a cell, a header, or a file name.
      reason: `Raw data viewed for source "${row.name}" (${row.source_kind}) — ${rowCount} row(s), in-browser only.`,
      afterState: { sourceKind: row.source_kind, rowCount },
    });
    return { authorized: true };
  }

  /**
   * Phase 3G-2: record a Gateway customer/column event — a POST-HOC, METADATA-
   * ONLY fact. The actual operation (resolve/write/create/column-create)
   * already ran entirely within the client environment, through the Gateway;
   * this call never receives and cannot receive an identity value, a field
   * value, or the database row itself (see parseGatewayEvent's forbidden-field
   * list). `action` overrides the controller's default @Audited name so one
   * route can record any of the fixed allowlisted actions correctly.
   *
   * FAIL CLOSED on the same terms as recordRawAccess: source must exist, be
   * active, and be gateway_connected.
   */
  async recordGatewayEvent(id: string, action: GatewayCustomerEventAction, rowCount?: number): Promise<{ recorded: true }> {
    const row = await this.repo.findOne(id);
    if (!row || row.status !== 'active') {
      throw new NotFoundException('Data source not found or has been removed.');
    }
    if (row.data_access_mode !== 'gateway_connected') {
      throw new ForbiddenException('This data source is metadata-only. Enable Gateway-connected mode first.');
    }
    this.audit.annotate({
      action,
      targetType: 'data_source',
      targetId: id,
      reason: `Gateway event "${action}" for source "${row.name}".`,
      afterState: rowCount !== undefined ? { rowCount } : undefined,
    });
    return { recorded: true };
  }

  /**
   * Phase 3G-1: record which existing column identifies a customer in this
   * source. Config ONLY — a column NAME, explicitly chosen by staff. This does
   * NOT perform a lookup and NEVER touches a customer value; that is Phase 3G-2.
   */
  async setIdentityColumn(id: string, identityColumn: string | null): Promise<DataSource> {
    const before = await this.repo.findOne(id);
    if (!before || before.status !== 'active') {
      throw new NotFoundException('Data source not found or has been removed.');
    }
    const row = await this.repo.setIdentityColumn(id, identityColumn);
    if (!row) throw new NotFoundException('Data source not found or has been removed.');
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      reason: identityColumn
        ? `Data source "${row.name}" customer identity column set to "${identityColumn}".`
        : `Data source "${row.name}" customer identity column cleared.`,
      beforeState: { identityColumn: before.identity_column },
      afterState: { identityColumn },
    });
    return toResponse(row);
  }

  /**
   * Phase 3H-1: record the CENTRAL customer-write configuration — whether
   * creation is allowed and which column NAMES are writable. Config ONLY: a
   * boolean and a list of names, explicitly chosen by staff. This does not
   * perform a write and never touches a customer value. The Gateway agent's
   * own local config is separate and still independently enforced — this is
   * defence in depth, not a replacement.
   */
  async setCustomerWriteConfig(
    id: string,
    allowCustomerCreate: boolean,
    writableColumns: readonly string[],
  ): Promise<DataSource> {
    const before = await this.repo.findOne(id);
    if (!before || before.status !== 'active') {
      throw new NotFoundException('Data source not found or has been removed.');
    }
    const row = await this.repo.setCustomerWriteConfig(id, allowCustomerCreate, writableColumns);
    if (!row) throw new NotFoundException('Data source not found or has been removed.');
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      reason: `Data source "${row.name}" customer-write config set (allowCustomerCreate=${allowCustomerCreate}, writableColumns=${writableColumns.length}).`,
      beforeState: { allowCustomerCreate: before.allow_customer_create, writableColumns: before.writable_columns },
      afterState: { allowCustomerCreate, writableColumns },
    });
    return toResponse(row);
  }

  async remove(id: string, reason: string | null): Promise<DataSource> {
    const row = await this.repo.tombstone(id, reason, this.tenantContext.getOrThrow().userId);
    if (!row) throw new NotFoundException('Data source not found or already removed.');
    this.audit.annotate({
      targetType: 'data_source',
      targetId: id,
      reason: reason ?? 'Data source removed.',
      beforeState: { status: 'active' },
      afterState: { status: 'tombstoned' },
    });
    return toResponse(row);
  }
}

/** Maps a row to the API view — deliberately DROPS gateway_binding_ref and the
 *  mode-changer id, and there is no value/secret field to drop because none is
 *  stored. */
function toResponse(row: DataSourceRow): DataSource {
  return {
    id: row.id,
    name: row.name,
    sourceKind: row.source_kind,
    dataAccessMode: row.data_access_mode,
    status: row.status,
    connectionHint: row.connection_hint,
    identityColumn: row.identity_column,
    allowCustomerCreate: row.allow_customer_create,
    writableColumns: row.writable_columns,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    modeLastChangedAt: row.mode_last_changed_at ? row.mode_last_changed_at.toISOString() : null,
  };
}
