import {
  BadRequestException,
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
import { RegisterService } from './register.service';
import {
  parsePiiDecisionInput,
  parseRegisterEntryInput,
  parseTombstoneInput,
} from './register.dto';
import type { RegisterEntryRow, RegisterEntryVersionRow } from './register-entries.repository';

/**
 * The Data Inventory register (FR-INV-01/08): guided-form entry of data
 * elements (what/why/where/how-long), with full version history. This is
 * separate from /inventory/discover — that records structural facts a
 * SchemaSource found; this register is the compliance description a human
 * authors and edits, and it is what the guided form builds against.
 */
@Controller('inventory/register')
@UseGuards(TenantGuard)
export class RegisterController {
  constructor(private readonly register: RegisterService) {}

  @Post()
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.register.entry_created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const fields = parseRegisterEntryInput(body);
    const { entry, version } = await this.register.create(fields);
    return {
      id: entry.id,
      status: entry.status,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
      ...toPiiResponse(entry),
      version: toVersionResponse(version),
    };
  }

  /** The register: every entry's current version. */
  @Get()
  async list(@Query('includeTombstoned') includeTombstoned?: string) {
    const rows = await this.register.list(includeTombstoned === 'true');
    return {
      elements: rows.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        piiCategory: r.pii_category,
        piiConfidence: r.pii_confidence,
        piiDecision: r.pii_decision,
        versionNumber: r.version_number,
        category: r.category,
        description: r.description,
        storageLocation: r.storage_location,
        purposeCount: r.purpose_count,
        // Deprecated flat fields — only ever non-null on versions created
        // before Prompt 14 (FR-INV-05). See inventory_entry_purposes.
        legacyPurpose: r.purpose,
        legacyRetentionPeriod: r.retention_period,
      })),
    };
  }

  /**
   * A PII classification suggestion for arbitrary text (FR-INV-03) — a CSV
   * column header from the import mapping screen, or a category/description a
   * human is typing in the guided form. GET (not POST): it is a pure lookup,
   * so it is also exempt from RolesGuard's read-only floor and from S5
   * auditing by construction — see RegisterService.suggest()'s doc comment.
   * Placed before `:id` so it isn't swallowed by that param route.
   */
  @Get('classify-suggestion')
  classifySuggestion(@Query('text') text?: string) {
    if (!text || !text.trim()) {
      throw new BadRequestException('text is required.');
    }
    const suggestion = this.register.suggest(text);
    return {
      category: suggestion?.category ?? null,
      confidence: suggestion?.confidence ?? null,
    };
  }

  /** One entry, with its full version history (FR-INV-08). */
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const { entry, versions } = await this.register.findOne(id);
    return {
      id: entry.id,
      status: entry.status,
      tombstoneReason: entry.tombstone_reason,
      tombstonedAt: entry.tombstoned_at,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
      ...toPiiResponse(entry),
      versions: versions.map(toVersionResponse),
    };
  }

  /**
   * Record accept/reject on the current PII classification suggestion for
   * this entry (FR-INV-04). The suggestion is re-derived server-side, not
   * trusted from the client — see RegisterService.decidePii().
   */
  @Post(':id/pii-decision')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.register.pii_decision')
  async decidePii(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { decision, reason } = parsePiiDecisionInput(body);
    const entry = await this.register.decidePii(id, decision, reason);
    return toPiiResponse(entry);
  }

  /** Edit. Creates a new version — nothing is ever overwritten (FR-INV-08). */
  @Patch(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.register.entry_updated')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const fields = parseRegisterEntryInput(body);
    const version = await this.register.update(id, fields);
    return toVersionResponse(version);
  }

  /** Soft-delete. Never a hard delete — dpdp_app holds no DELETE grant (I4). */
  @Delete(':id')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('inventory.register.entry_tombstoned')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneInput(body);
    const entry = await this.register.tombstone(id, reason);
    return { id: entry.id, status: entry.status, tombstonedAt: entry.tombstoned_at };
  }
}

function toPiiResponse(entry: RegisterEntryRow) {
  return {
    piiCategory: entry.pii_category,
    piiConfidence: entry.pii_confidence,
    piiDecision: entry.pii_decision,
    piiDecisionReason: entry.pii_decision_reason,
    piiDecidedAt: entry.pii_decided_at,
  };
}

function toVersionResponse(v: RegisterEntryVersionRow) {
  return {
    versionNumber: v.version_number,
    category: v.category,
    description: v.description,
    storageLocation: v.storage_location,
    createdAt: v.created_at,
    // Deprecated flat fields — see register.dto.ts / the Prompt 14 migration.
    legacyPurpose: v.purpose,
    legacyRetentionPeriod: v.retention_period,
  };
}
