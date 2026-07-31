import { Injectable } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RopaRepository, type RopaEntryRow } from './ropa.repository';
import { renderRopaPdf } from './ropa-pdf';
import { renderRopaXlsx } from './ropa-xlsx';
import type { RopaFormat } from './ropa.dto';

export interface RopaExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

/**
 * FR-INV-09 — the Record of Processing Activities. Generates fresh from the
 * CURRENT state of the register on every call (RopaRepository re-reads the
 * database each time; nothing is cached or persisted) — an export is a
 * point-in-time rendering, never a stored artefact, so it can never go stale
 * out from under a compliance officer relying on it.
 */
@Injectable()
export class RopaService {
  constructor(
    private readonly repo: RopaRepository,
    private readonly identity: IdentityService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * The register's current state as DATA rather than as a document.
   *
   * Added for the DPR Personal Data Summary (FR-DPR-04), which needs exactly
   * what the RoPA needs — every active element with its purposes, legal bases,
   * retention, systems and vendors — but renders it per data principal instead
   * of per organisation. Exposed here rather than by exporting RopaRepository,
   * so DPRequestModule reads inventory through a service and never touches
   * inventory tables itself (R2).
   *
   * Read-only and uncached, like `export`: the summary a data principal is
   * handed reflects the register as it is at that instant, not as it was when
   * something last warmed a cache.
   */
  activeEntries(): Promise<RopaEntryRow[]> {
    return this.repo.listActiveEntries();
  }

  async export(format: RopaFormat): Promise<RopaExportResult> {
    const [entries, user] = await Promise.all([this.repo.listActiveEntries(), this.identity.currentUser()]);
    const generatedAt = new Date();
    const orgName = user.organisationName;
    const datePart = generatedAt.toISOString().slice(0, 10);
    const safeOrgName = orgName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'organisation';

    this.audit.annotate({
      targetType: 'ropa_export',
      targetId: null,
      reason: `RoPA exported as ${format.toUpperCase()} — ${entries.length} active data element(s)`,
      afterState: { format, elementCount: entries.length, generatedAt: generatedAt.toISOString() },
    });

    if (format === 'pdf') {
      const buffer = await renderRopaPdf({ organisationName: orgName, generatedAt, entries });
      return {
        buffer,
        contentType: 'application/pdf',
        filename: `RoPA-${safeOrgName}-${datePart}.pdf`,
      };
    }

    const buffer = await renderRopaXlsx({ organisationName: orgName, generatedAt, entries });
    return {
      buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `RoPA-${safeOrgName}-${datePart}.xlsx`,
    };
  }
}
