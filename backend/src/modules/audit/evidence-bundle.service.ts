import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '@dpdp/shared';
import { IdentityService } from '../identity/identity.service';
import { AuditVerifierService } from './audit-verifier.service';
import { renderEvidenceBundlePdf } from './evidence-bundle-pdf';

/**
 * FR-AUD-05 — the exportable, verifiable evidence bundle: "what the client
 * hands a regulator."
 *
 * Assembled entirely from `AuditVerifierService`'s existing, READ-ONLY surface
 * — `verifyChain()` and `list()` — never from a repository of its own. This
 * file has no SQL in it. That is deliberate: an evidence bundle is a
 * PRESENTATION of the chain the verifier already inspects, and giving it its
 * own query path would be a second way to read `audit_log` to keep in sync
 * with the first (and, per `audit-write-path.spec.ts`, an outright violation
 * to write raw SQL against it from outside the audit module — this file
 * respects that boundary by staying a caller, not a second implementation).
 *
 * WHY IT WALKS EVERY ENTRY RATHER THAN A CAPPED PAGE. The dashboard's audit
 * viewer (FR-AUD-04) is deliberately paged for browsing — 200 rows is plenty
 * to look at. A bundle handed to a regulator is a different document with a
 * different job: it has to be checkable against the chain's own guarantee,
 * which only holds if nothing between seq 1 and the head was quietly left out.
 * `list()`'s keyset cursor (`before`) is walked backwards from the head until
 * exhausted, then reversed, so the bundle reads in the same chronological
 * order the chain verifies in.
 */
@Injectable()
export class EvidenceBundleService {
  constructor(
    private readonly verifier: AuditVerifierService,
    private readonly identity: IdentityService,
  ) {}

  async generate(): Promise<{ buffer: Buffer; filename: string }> {
    const [report, entries, user] = await Promise.all([
      this.verifier.verifyChain(),
      this.walkAll(),
      this.identity.currentUser(),
    ]);

    const generatedAt = new Date();
    const buffer = await renderEvidenceBundlePdf({
      organisationName: user.organisationName,
      generatedAt,
      report,
      entries,
    });

    const datePart = generatedAt.toISOString().slice(0, 10);
    return { buffer, filename: `DPDP-Evidence-Bundle-${datePart}.pdf` };
  }

  /** Every entry in this tenant's chain, oldest first. A page at a time via the
   *  same keyset cursor the dashboard viewer uses, so there is exactly one
   *  paging strategy for `audit_log` in the whole codebase. */
  private async walkAll(): Promise<AuditEntry[]> {
    const PAGE = 500;
    const descending: AuditEntry[] = [];
    let before: number | undefined;

    for (;;) {
      const page = await this.verifier.list(PAGE, before);
      if (page.length === 0) {
        break;
      }
      descending.push(...page);
      before = page[page.length - 1]!.seq;
      if (page.length < PAGE) {
        break;
      }
    }

    return descending.reverse();
  }
}
