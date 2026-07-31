import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PurposeLink, PurposeLinkSuggestion } from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { PurposeLinksRepository } from './purpose-links.repository';
import { scoreCandidate, suggestLinks } from './purpose-link-suggester';

/**
 * Curating the consent-purpose <-> inventory-purpose mapping (FR-DPR-04).
 *
 * The mapping is what lets Tier 1 say "these categories of YOUR data" rather
 * than "here is our whole register, work it out". Its correctness is the
 * correctness of a statutory document, which is why the machine only ever
 * suggests and a person always decides — see `purpose-link-suggester.ts`.
 */
@Injectable()
export class PurposeLinksService {
  constructor(
    private readonly repo: PurposeLinksRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async list(): Promise<PurposeLink[]> {
    const rows = await this.repo.list();
    return rows.map((r) => ({
      id: r.id,
      consentPurposeId: r.consent_purpose_id,
      consentPurposeName: r.consent_purpose_name,
      inventoryPurposeId: r.inventory_purpose_id,
      inventoryPurposeName: r.inventory_purpose_name,
      entryCategory: r.entry_category,
      origin: r.origin,
      suggestionConfidence: r.suggestion_confidence === null ? null : Number(r.suggestion_confidence),
      linkedAt: r.linked_at.toISOString(),
    }));
  }

  async suggest(): Promise<PurposeLinkSuggestion[]> {
    return suggestLinks(await this.repo.listCandidates());
  }

  /**
   * Create a link. The confidence recorded against it is RE-DERIVED here from
   * the two names as the database currently holds them — never taken from the
   * request body.
   *
   * That matters more than it looks. If the client supplied the score, the row
   * would read "a human accepted a 0.98 suggestion" for a pairing the platform
   * actually rated 0.36, and the one signal a later reviewer has for "did
   * somebody wave through a weak guess?" would be forged. Same rule, same
   * reasoning, as the PII classifier's accept path.
   */
  async link(consentPurposeId: string, inventoryPurposeId: string): Promise<PurposeLink> {
    const ctx = this.tenantContext.getOrThrow();
    const candidates = await this.repo.listCandidates();
    const candidate = candidates.find(
      (c) => c.consent_purpose_id === consentPurposeId && c.inventory_purpose_id === inventoryPurposeId,
    );
    if (!candidate) {
      // Either id is unknown, tombstoned, or belongs to another tenant (RLS
      // already made the last one invisible). One message for all three: a
      // caller probing ids learns nothing from the difference.
      throw new NotFoundException(
        'That consent purpose and inventory purpose pair is not available to link.',
      );
    }
    if (candidate.already_linked) {
      throw new BadRequestException('These purposes are already linked.');
    }

    const { score } = scoreCandidate(candidate.consent_purpose_name, candidate.inventory_purpose_name);
    const created = await this.repo.create({
      consentPurposeId,
      inventoryPurposeId,
      // 'accepted_suggestion' only when the platform would actually have
      // suggested it; below the floor, a human made this connection on their
      // own judgement and the record should say so.
      origin: score >= 0.35 ? 'accepted_suggestion' : 'manual',
      confidence: score > 0 ? score : null,
      linkedBy: ctx.userId,
    });

    this.audit.annotate({
      targetType: 'consent_purpose_inventory_link',
      targetId: created.id,
      reason:
        `Linked consent purpose "${candidate.consent_purpose_name}" to inventory purpose ` +
        `"${candidate.inventory_purpose_name}" (${candidate.entry_category})`,
      afterState: {
        consentPurposeId,
        inventoryPurposeId,
        suggestionConfidence: score,
        entryCategory: candidate.entry_category,
      },
    });

    return {
      id: created.id,
      consentPurposeId,
      consentPurposeName: candidate.consent_purpose_name,
      inventoryPurposeId,
      inventoryPurposeName: candidate.inventory_purpose_name,
      entryCategory: candidate.entry_category,
      origin: score >= 0.35 ? 'accepted_suggestion' : 'manual',
      suggestionConfidence: score > 0 ? score : null,
      linkedAt: new Date().toISOString(),
    };
  }

  async unlink(linkId: string, reason: string): Promise<{ id: string; status: 'removed' }> {
    const ctx = this.tenantContext.getOrThrow();
    const removed = await this.repo.remove(linkId, ctx.userId, reason);
    if (!removed) {
      throw new NotFoundException('That link does not exist or has already been removed.');
    }
    this.audit.annotate({
      targetType: 'consent_purpose_inventory_link',
      targetId: linkId,
      reason,
      beforeState: { status: 'active' },
      afterState: { status: 'removed' },
    });
    return { id: linkId, status: 'removed' };
  }
}
