import { Injectable } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RopaRepository } from './ropa.repository';
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
