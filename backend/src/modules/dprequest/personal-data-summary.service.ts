import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  PersonalDataSummary,
  SummaryConsentRecord,
  SummaryDataCategory,
  SummaryRequestRecord,
} from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { IdentityService } from '../identity/identity.service';
import { ConsentService } from '../consent/consent.service';
import { RopaService } from '../inventory/ropa.service';
import { RequestService } from '../request/request.service';
import { DPRequestDetailsRepository } from './dprequest-details.repository';
import { PurposeLinksRepository } from './purpose-links.repository';

/**
 * TIER 1 OF THE PERSONAL DATA SUMMARY (FR-DPR-04).
 *
 * ===========================================================================
 * WHAT THIS SERVICE DOES NOT DO, WHICH IS THE POINT OF IT
 *
 * It writes nothing. There is no repository injected here that can insert a
 * row, no cache, no memoisation, no `summaries` table anywhere in this feature.
 * Every call re-derives the whole document from three registers that already
 * exist, and the result exists only in the HTTP response.
 *
 * That is not frugality, it is I1. The moment a "personal data summary" is
 * stored per subject, the platform is holding a per-customer record — a file
 * about a named individual, assembled and kept. It would be the most defensible
 * cache in the codebase and it would end the product's central claim. So the
 * summary is a VIEW, permanently.
 *
 * Nothing here handles a raw customer id either. The subject is identified by
 * the HMAC'd `subject_ref` already resolved onto the ticket (FR-DPR-02); this
 * service never sees, accepts, or could log the value that produced it.
 * ===========================================================================
 *
 * HOW THE THREE SOURCES COMBINE, and why it is not a join:
 *
 *   Consent Register  ->  which PURPOSES this person agreed to, and when.
 *   Purpose links     ->  which INVENTORY purposes those consent purposes reach
 *                         (tenant-curated; see the migration for why not fuzzy).
 *   Data Inventory    ->  for those inventory purposes: the data CATEGORY, its
 *                         legal basis, retention, systems and vendors.
 *   Request register  ->  what this person has asked for before.
 *
 * The inventory read is the tenant's whole active register — the same data the
 * RoPA renders — filtered IN MEMORY down to the entries this subject's consents
 * actually reach. Filtering in memory rather than in SQL is deliberate: it
 * keeps the attribution logic in one readable place, and it makes the
 * `unrelatedEntryCount` below computable, which is what lets the document say
 * "and there are N other things we hold that are nothing to do with you"
 * instead of silently omitting them.
 */
@Injectable()
export class PersonalDataSummaryService {
  constructor(
    private readonly requests: RequestService,
    private readonly details: DPRequestDetailsRepository,
    private readonly links: PurposeLinksRepository,
    private readonly consent: ConsentService,
    private readonly ropa: RopaService,
    private readonly identity: IdentityService,
    private readonly audit: AuditContextService,
  ) {}

  async assemble(ticketId: string): Promise<PersonalDataSummary> {
    const ticket = await this.requests.detail(ticketId);
    if (ticket.ticket.requestType !== 'dprequest') {
      throw new NotFoundException('Rights request not found.');
    }
    const detail = await this.details.find(ticketId);
    if (!detail?.subject_ref) {
      // Refusing rather than returning an empty document. A summary with no
      // subject reference is not a summary of nobody — it is a summary the
      // platform cannot attribute, and handing one over would invite it being
      // read as "we hold nothing about you".
      throw new BadRequestException(
        'Resolve this request’s subject reference first (FR-DPR-02). Without it there is no ' +
          'basis on which to attribute any record to this person.',
      );
    }
    const subjectRef = detail.subject_ref;

    // Four independent reads. None of them writes; none of them takes a raw id.
    //
    // The consent read is bitemporal and both clocks are set to NOW: "what is
    // true at this moment, using everything we know at this moment". That is
    // the only honest setting for this document — a data principal asking what
    // you hold is asking about today, not about what you believed last March.
    // The two clocks are passed explicitly rather than defaulted so the choice
    // is visible here rather than inherited from a default that could change.
    const now = new Date().toISOString();
    const [consentView, entries, priorRequests, user] = await Promise.all([
      this.consent.subjectHistory(subjectRef, { asOf: now, knownAs: now }, 500),
      this.ropa.activeEntries(),
      this.details.findBySubjectRef(subjectRef),
      this.identity.currentUser(),
    ]);

    // Every purpose this person has ANY consent record for — including
    // withdrawn ones. A withdrawn consent still means the organisation held
    // that data, and a summary that showed only live consents would hide the
    // processing a data principal is most likely asking about.
    const consentPurposeIds = [...new Set(consentView.events.map((e) => e.purpose_id))];
    const linkMap = await this.links.activeFor(consentPurposeIds);

    // inventory purpose id -> the consent purpose names that reach it. Built
    // once so the attribution can be stated on each row rather than implied.
    const attribution = new Map<string, Set<string>>();
    const purposeNames = new Map<string, string>();
    for (const event of consentView.events) {
      purposeNames.set(event.purpose_id, event.purpose_name ?? event.purpose_id);
    }
    for (const [consentPurposeId, inventoryPurposeIds] of linkMap) {
      const label = purposeNames.get(consentPurposeId) ?? consentPurposeId;
      for (const inventoryPurposeId of inventoryPurposeIds) {
        const set = attribution.get(inventoryPurposeId) ?? new Set<string>();
        set.add(label);
        attribution.set(inventoryPurposeId, set);
      }
    }

    const dataCategories: SummaryDataCategory[] = [];
    let unrelatedEntryCount = 0;

    for (const entry of entries) {
      // An entry's purposes are matched by ID, never by name — the whole reason
      // the link table exists. `purposeId` comes back on each RoPA purpose row
      // precisely so this attribution can be exact.
      const attributedPurposes = entry.purposes
        .filter((p) => attribution.has(p.purposeId))
        .map((p) => ({
          purposeName: p.purposeName,
          legalBasis: p.legalBasis,
          legalBasisNote: p.legalBasisNote,
          retentionPeriod: p.retentionPeriod,
          viaConsentPurposes: [...(attribution.get(p.purposeId) ?? [])].sort(),
        }));

      if (attributedPurposes.length === 0) {
        unrelatedEntryCount += 1;
        continue;
      }

      dataCategories.push({
        entryId: entry.id,
        category: entry.category,
        description: entry.description,
        storageLocation: entry.storage_location,
        piiCategory: entry.pii_category,
        purposes: attributedPurposes,
        systems: entry.systems.map((s) => ({
          name: s.name,
          systemType: s.systemType,
          hostingLocation: s.hostingLocation,
        })),
        vendors: entry.vendors.map((v) => ({
          name: v.name,
          country: v.country,
          transferNotes: v.transferNotes,
        })),
      });
    }

    // The honesty section. A consent purpose the tenant has never mapped
    // produces no data categories — and if that were left silent, the document
    // would imply the organisation holds nothing for it. Naming the gap is the
    // difference between an incomplete answer and a misleading one.
    const unattributed = [...new Set(consentView.statusAsOf.map((e) => e.purpose_id))]
      .filter((purposeId) => (linkMap.get(purposeId) ?? []).length === 0)
      .map((purposeId) => {
        const current = consentView.statusAsOf.find((e) => e.purpose_id === purposeId)!;
        return {
          purposeId,
          purposeName: current.purpose_name,
          status: current.status,
        };
      });

    const summary: PersonalDataSummary = {
      subjectRef,
      referenceCode: ticket.ticket.referenceCode,
      rightType: detail.right_type,
      generatedAt: new Date().toISOString(),
      organisationName: user.organisationName,
      dataCategories,
      consentHistory: consentView.events.map(toConsentRecord),
      currentConsentStatus: consentView.statusAsOf.map(toConsentRecord),
      requestHistory: priorRequests.map(toRequestRecord),
      unattributedConsentPurposes: unattributed,
      unrelatedEntryCount,
    };

    // Audited because generating someone's data summary is a compliance-
    // significant act, and because an auditor should be able to see it happened
    // without the document itself being retained. Counts and the subject REF —
    // never a category list, never a value, never a raw id.
    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticketId,
      reason: `Tier 1 personal data summary assembled for ${ticket.ticket.referenceCode}`,
      afterState: {
        subjectRef,
        dataCategoryCount: dataCategories.length,
        consentEventCount: summary.consentHistory.length,
        priorRequestCount: summary.requestHistory.length,
        unattributedPurposeCount: unattributed.length,
        unrelatedEntryCount,
      },
    });

    return summary;
  }
}

function toConsentRecord(row: {
  purpose_id: string;
  purpose_name: string | null;
  status: string;
  occurred_at: Date;
  recorded_at: Date;
  source: string;
  notice_version_id: string | null;
  evidence_hash: string;
}): SummaryConsentRecord {
  return {
    purposeId: row.purpose_id,
    purposeName: row.purpose_name,
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    source: row.source,
    noticeVersionId: row.notice_version_id,
    evidenceHash: row.evidence_hash,
  };
}

function toRequestRecord(row: {
  reference_code: string;
  right_type: string | null;
  status: string;
  created_at: Date;
  closed_at: Date | null;
  sla_due_at: Date | null;
}): SummaryRequestRecord {
  return {
    referenceCode: row.reference_code,
    rightType: row.right_type,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    slaDueAt: row.sla_due_at?.toISOString() ?? null,
    // Null while open — an unfinished request is not late until its deadline
    // passes, and calling it "not on time" before then would be wrong.
    closedOnTime:
      row.closed_at && row.sla_due_at
        ? row.closed_at.getTime() <= row.sla_due_at.getTime()
        : null,
  };
}
