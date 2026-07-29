import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { classifyPii, type PiiSuggestion } from './pii-classifier';
import {
  RegisterEntriesRepository,
  type RegisterEntryFields,
  type RegisterEntryRow,
  type RegisterEntryVersionRow,
} from './register-entries.repository';

function piiState(entry: RegisterEntryRow) {
  return {
    piiCategory: entry.pii_category,
    piiConfidence: entry.pii_confidence,
    piiDecision: entry.pii_decision,
    piiDecisionReason: entry.pii_decision_reason,
  };
}

function versionState(v: RegisterEntryVersionRow) {
  return {
    versionNumber: v.version_number,
    category: v.category,
    description: v.description,
    storageLocation: v.storage_location,
  };
}

/**
 * Data Inventory register (FR-INV-01/08): the guided-form entity model —
 * category/purpose/storage/retention per data element — with full version
 * history. Distinct from InventoryService's discovery walk (S4): this is the
 * curated compliance description a human authors, not structural metadata a
 * SchemaSource found.
 */
@Injectable()
export class RegisterService {
  constructor(
    private readonly repo: RegisterEntriesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async create(fields: RegisterEntryFields) {
    const ctx = this.tenantContext.getOrThrow();
    const { entry, version } = await this.repo.create(fields, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_register_entry',
      targetId: entry.id,
      reason: `Data element "${fields.category}" added to the register`,
      afterState: versionState(version),
    });

    return { entry, version };
  }

  list(includeTombstoned: boolean) {
    return this.repo.listCurrent(includeTombstoned);
  }

  /** Element/category counters for the compliance dashboard (FR-DSH-01). */
  summary() {
    return this.repo.summary();
  }

  async findOne(id: string) {
    const found = await this.repo.findOne(id);
    if (!found) {
      throw new NotFoundException('Data element not found.');
    }
    return found;
  }

  async update(id: string, fields: RegisterEntryFields) {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.addVersion(id, fields, ctx.userId);
    if (!result) {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_register_entry',
      targetId: id,
      reason: `Data element "${fields.category}" edited (version ${result.next.version_number})`,
      beforeState: versionState(result.previous),
      afterState: versionState(result.next),
    });

    return result.next;
  }

  async tombstone(id: string, reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const entry = await this.repo.tombstone(id, reason, ctx.userId);
    if (!entry) {
      throw new NotFoundException('Data element not found, or it is already tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_register_entry',
      targetId: id,
      reason: reason ?? 'Data element removed from the register',
      afterState: { status: 'tombstoned' },
    });

    return entry;
  }

  /**
   * A stateless PII classification suggestion (FR-INV-03) for arbitrary text —
   * a CSV column header (Prompt 10's import mapping) or an entry's own
   * category/description (this entry's guided-form text, Prompt 9). Never a
   * data value (I1) — see pii-classifier.ts's doc comment for the full
   * argument. Pure computation: nothing is read or written, so nothing is
   * audited (the interceptor never audits GETs anyway).
   */
  suggest(text: string): PiiSuggestion | null {
    return classifyPii(text);
  }

  /**
   * Record a human's accept/reject decision on the CURRENT suggestion for one
   * entry (FR-INV-04). The suggestion is re-derived server-side from the
   * entry's own category/description rather than trusted from the client, so
   * an "accepted" classification in the audit trail is always backed by what
   * the platform actually suggested, not whatever a client happened to send.
   */
  async decidePii(id: string, decision: 'accepted' | 'rejected', reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const found = await this.repo.findOne(id);
    if (!found || found.entry.status !== 'active') {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }

    const current = found.versions[0]!; // every entry has at least version 1
    const suggestion = classifyPii(current.category) ?? classifyPii(current.description ?? '');
    if (!suggestion) {
      throw new BadRequestException(
        'No PII classification is currently suggested for this data element — nothing to decide.',
      );
    }

    const result = await this.repo.setPiiDecision(
      id,
      { category: suggestion.category, confidence: suggestion.confidence, decision, reason },
      ctx.userId,
    );
    if (!result) {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_register_entry',
      targetId: id,
      reason:
        reason ??
        `PII classification "${suggestion.category}" (${suggestion.confidence} confidence) ${decision}`,
      beforeState: piiState(result.previous),
      afterState: piiState(result.next),
    });

    return result.next;
  }
}
