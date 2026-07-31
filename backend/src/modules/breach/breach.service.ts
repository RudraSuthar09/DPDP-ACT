import { createHash, randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  BREACH_GATES,
  breachPolicyKey,
  type BreachDataCategory,
  type BreachDeadlinePolicy,
  type BreachGate,
  type BreachGateStatus,
  type BreachIncident,
  type BreachIncidentDetail,
  type BreachTemplate,
  type BreachTemplateKind,
  type EscalationLadderStep,
} from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { IdentityService } from '../identity/identity.service';
import { RopaService } from '../inventory/ropa.service';
import { DeadlinePolicyService } from '../deadlines/deadline-policy.service';
import { BreachRepository, type IncidentRow } from './breach.repository';
import { BreachDeadlineService } from './breach-deadline.service';
import { renderTemplate } from './breach-templates';
import { renderClosurePacketPdf } from './breach-closure-pdf';
import type { CreateIncidentBody, EvidenceBody } from './dto';

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The Breach Register (FR-BRC-01…07).
 *
 * Owns incidents, their gated workflow and their evidence attestations. It does
 * NOT own: the deadline mechanism (DeadlinePolicyService, shared with the
 * request substrate), deadline firing (Seam S3), who holds an escalation rung
 * (IdentityService), or data categories (RopaService). Each is a service call
 * across a module boundary, never a table read (R2).
 */
@Injectable()
export class BreachService {
  private readonly logger = new Logger(BreachService.name);

  constructor(
    private readonly db: TenantDatabaseService,
    private readonly repo: BreachRepository,
    private readonly deadlines: BreachDeadlineService,
    private readonly policies: DeadlinePolicyService,
    private readonly ropa: RopaService,
    private readonly identity: IdentityService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  // --- intake (FR-BRC-01) --------------------------------------------------

  /**
   * Open an incident and start every gate's clock.
   *
   * All of it in ONE transaction — the incident, its category references, and
   * every scheduled deadline — because `TenantDatabaseService.withTenant` joins
   * the unit of work the audit interceptor opened for this request. An incident
   * that existed without its deadlines would be the worst failure available
   * here: a breach on the books with no clock running on it.
   */
  async open(input: CreateIncidentBody): Promise<BreachIncident> {
    const ctx = this.tenantContext.getOrThrow();
    // A tenant that registered after the migration ran has no policy records;
    // seed before scheduling so no deadline resolves to an uncited fallback.
    const seeded = await this.deadlines.ensureSeeded();
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} breach deadline policy record(s) for this tenant.`);
    }

    // Validate the category references BEFORE opening anything. An incident
    // pointing at a register entry that does not exist is not a recoverable
    // state, and letting the FK fail mid-transaction would surface it as an
    // opaque database error instead of a usable message.
    if (input.dataCategoryEntryIds.length > 0) {
      const entries = await this.ropa.activeEntries();
      const known = new Set(entries.map((e) => e.id));
      const unknown = input.dataCategoryEntryIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Not active entries in the Data Inventory: ${unknown.join(', ')}`,
        );
      }
    }

    const incident = await this.db.withTenant(async (client) => {
      const row = await this.repo.insert(client, {
        referenceCode: mintReference(),
        title: input.title,
        whatHappened: input.whatHappened,
        discoveredAt: input.discoveredAt,
        occurredAt: input.occurredAt,
        systemsAffected: input.systemsAffected,
        estimatedAffectedCount: input.estimatedAffectedCount,
        severity: input.severity,
        openedBy: ctx.userId,
      });
      await this.repo.linkCategories(client, row.id, input.dataCategoryEntryIds);
      await this.deadlines.scheduleAll(client, row);
      return row;
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: incident.id,
      reason: `Breach incident ${incident.reference_code} opened`,
      afterState: {
        referenceCode: incident.reference_code,
        severity: incident.severity,
        discoveredAt: incident.discovered_at.toISOString(),
        dataCategoryCount: input.dataCategoryEntryIds.length,
        estimatedAffectedCount: input.estimatedAffectedCount,
      },
    });

    return toIncident(incident);
  }

  // --- reads ---------------------------------------------------------------

  async list(filters: { status?: 'open' | 'closed'; limit: number }): Promise<BreachIncident[]> {
    const rows = await this.repo.list(filters);
    return rows.map(toIncident);
  }

  async detail(id: string): Promise<BreachIncidentDetail> {
    const loaded = await this.db.withTenant(async (client) => {
      const incident = await this.requireIncident(client, id);
      const [gateEvents, deadlines, evidence, escalations, entryIds] = await Promise.all([
        this.repo.listGateEvents(client, id),
        this.repo.listDeadlines(client, id),
        this.repo.listEvidence(client, id),
        this.repo.listEscalations(client, id),
        this.repo.listCategoryEntryIds(client, id),
      ]);
      return { incident, gateEvents, deadlines, evidence, escalations, entryIds };
    });

    // Categories resolve through the Inventory service, so an incident reports
    // the register's CURRENT truth — rename a category in the inventory and
    // this reads the new name, because it never held a copy.
    const dataCategories = await this.resolveCategories(loaded.entryIds);

    const now = Date.now();
    const gateStatuses: BreachGateStatus[] = BREACH_GATES.map((gate) => {
      const event = loaded.gateEvents.find((g) => g.gate === gate) ?? null;
      // A gate's own deadline is its 100% rung — the breach, not the warnings.
      const breachRung = loaded.deadlines.find(
        (d) => d.gate === gate && d.trigger_reason === 'sla_breach',
      );
      const dueAt = breachRung?.due_at ?? null;
      const fired = loaded.deadlines.filter((d) => d.gate === gate && d.status === 'fired');
      return {
        gate,
        dueAt: dueAt?.toISOString() ?? null,
        policyKey: breachRung?.policy_key ?? breachPolicyKey(gate),
        policyVersion: breachRung?.policy_version ?? null,
        completedAt: event?.completed_at.toISOString() ?? null,
        // Null while the gate is open: an unfinished gate is not late until its
        // own deadline has passed, and calling it late before then is wrong.
        completedOnTime: event && dueAt ? event.completed_at.getTime() <= dueAt.getTime() : null,
        overdue: !event && dueAt !== null && dueAt.getTime() < now,
        escalationLevel: fired.reduce((max, d) => Math.max(max, d.level), 0),
      };
    });

    return {
      incident: toIncident(loaded.incident),
      dataCategories,
      gateEvents: loaded.gateEvents.map((g) => ({
        gate: g.gate,
        notes: g.notes,
        completedBy: g.completed_by,
        completedAt: g.completed_at.toISOString(),
      })),
      gateStatuses,
      evidence: loaded.evidence.map((e) => ({
        id: e.id,
        fileName: e.file_name,
        contentType: e.content_type,
        sizeBytes: e.size_bytes,
        sha256: e.sha256,
        description: e.description,
        uploadedAt: e.uploaded_at.toISOString(),
      })),
      escalations: loaded.escalations.map((e) => ({
        gate: e.gate,
        level: e.level,
        rung: e.rung,
        trigger: e.trigger_reason,
        notifiedContact: e.notified_contact,
        notifiedOk: e.notified_ok,
        reason: e.reason,
        occurredAt: e.occurred_at.toISOString(),
      })),
    };
  }

  // --- the gated workflow (FR-BRC-03) --------------------------------------

  /**
   * Pass a gate.
   *
   * The ORDER is enforced, not suggested: a gate may only be passed once every
   * gate before it has been. That is what makes this a guided workflow rather
   * than seven independent checkboxes — you cannot report to the Board before
   * assessing what happened, and a trail claiming otherwise would be worse than
   * useless in an investigation.
   *
   * Passing a gate cancels that gate's remaining deadlines in the SAME
   * transaction, so a gate completed inside its window can never afterwards
   * escalate for being late.
   */
  async completeGate(
    id: string,
    gate: BreachGate,
    notes: string,
  ): Promise<{ incident: BreachIncident; gate: BreachGate }> {
    const ctx = this.tenantContext.getOrThrow();

    const result = await this.db.withTenant(async (client) => {
      const incident = await this.requireIncident(client, id);
      if (incident.status === 'closed') {
        throw new ConflictException('This incident is closed. Its workflow cannot be changed.');
      }

      const done = new Set((await this.repo.listGateEvents(client, id)).map((g) => g.gate));
      if (done.has(gate)) {
        throw new ConflictException(`The ${gate} gate has already been completed.`);
      }
      const missing = BREACH_GATES.slice(0, BREACH_GATES.indexOf(gate)).filter((g) => !done.has(g));
      if (missing.length > 0) {
        throw new ConflictException(
          `Complete ${missing.join(', ')} before ${gate}. The workflow is ordered on purpose: ` +
            'each gate depends on the findings of the one before it.',
        );
      }

      const event = await this.repo.recordGate(client, {
        incidentId: id,
        gate,
        notes,
        completedBy: ctx.userId,
      });
      if (!event) {
        throw new ConflictException('That gate was completed by someone else.');
      }

      const nextGate =
        BREACH_GATES[Math.min(BREACH_GATES.indexOf(gate) + 1, BREACH_GATES.length - 1)]!;
      await this.repo.advanceGate(client, id, nextGate);
      await this.deadlines.cancel(client, id, gate);

      return { incident, event };
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: id,
      reason: notes,
      beforeState: { currentGate: result.incident.current_gate },
      afterState: {
        gate,
        completedAt: result.event.completed_at.toISOString(),
        referenceCode: result.incident.reference_code,
      },
    });

    const refreshed = await this.db.withTenant((client) => this.requireIncident(client, id));
    return { incident: toIncident(refreshed), gate };
  }

  /** Closure with sign-off (FR-BRC-07). Requires every gate, `closure`
   *  included, to have been passed — the sign-off is the last act, not a
   *  shortcut past the ones before it. */
  async close(id: string, note: string): Promise<BreachIncident> {
    const ctx = this.tenantContext.getOrThrow();

    const closed = await this.db.withTenant(async (client) => {
      await this.requireIncident(client, id);
      const done = new Set((await this.repo.listGateEvents(client, id)).map((g) => g.gate));
      const missing = BREACH_GATES.filter((g) => !done.has(g));
      if (missing.length > 0) {
        throw new ConflictException(
          `Cannot close: ${missing.join(', ')} not completed. A closure packet has to be able to ` +
            'show every gate was passed.',
        );
      }
      const row = await this.repo.close(client, id, { signedOffBy: ctx.userId, note });
      if (!row) {
        throw new ConflictException('This incident is already closed.');
      }
      // Nothing chases a closed incident.
      await this.deadlines.cancel(client, id);
      return row;
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: id,
      reason: note,
      beforeState: { status: 'open' },
      afterState: {
        status: 'closed',
        referenceCode: closed.reference_code,
        closedAt: closed.closed_at?.toISOString() ?? null,
      },
    });

    return toIncident(closed);
  }

  // --- evidence (FR-BRC-05) ------------------------------------------------

  /**
   * Register a piece of evidence by its digest.
   *
   * The bytes arrive, are hashed, and are DISCARDED. Nothing writes them to
   * disk, to a column, or to a log. Same rule `ImportEvidenceStore` established
   * for CSV imports, and it matters more here: breach evidence is a forensic
   * export or a screenshot of an exposed record — the likeliest material in the
   * whole product to contain real personal data (I1/R6).
   *
   * What the tenant gets is an attestation: this digest, this size, this name,
   * at this time, by this person. Anyone holding the original can recompute the
   * digest and prove it is the same bytes. The platform attests; it does not
   * archive.
   */
  async addEvidence(id: string, input: EvidenceBody) {
    const ctx = this.tenantContext.getOrThrow();
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('contentBase64 did not decode to any bytes.');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sizeBytes = bytes.length;
    // `bytes` is not referenced again below. Nothing it points at is persisted.

    const row = await this.db.withTenant(async (client) => {
      const incident = await this.requireIncident(client, id);
      if (incident.status === 'closed') {
        throw new ConflictException('This incident is closed; its evidence set is sealed.');
      }
      return this.repo.insertEvidence(client, {
        incidentId: id,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes,
        sha256,
        description: input.description,
        uploadedBy: ctx.userId,
      });
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: id,
      reason: `Evidence registered: ${input.fileName}`,
      // The digest and the size. Never the content, and never a path to it —
      // there is no path, because there is no file.
      afterState: { evidenceId: row.id, fileName: row.file_name, sha256, sizeBytes },
    });

    return {
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      description: row.description,
      uploadedAt: row.uploaded_at.toISOString(),
    };
  }

  // --- templates (FR-BRC-06) ----------------------------------------------

  async template(id: string, kind: BreachTemplateKind): Promise<BreachTemplate> {
    const [detail, user] = await Promise.all([this.detail(id), this.identity.currentUser()]);
    const rendered = renderTemplate(kind, {
      organisationName: user.organisationName,
      incident: detail.incident,
      categories: detail.dataCategories,
      gateEvents: detail.gateEvents,
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: id,
      reason: `Notification template generated: ${kind}`,
      afterState: {
        kind,
        referenceCode: detail.incident.referenceCode,
        // Whether the draft is complete is the compliance-relevant fact.
        outstandingGaps: rendered.gaps.length,
      },
    });
    return rendered;
  }

  // --- deadline policies (FR-BRC-02) --------------------------------------

  async deadlinePolicies(): Promise<BreachDeadlinePolicy[]> {
    await this.deadlines.ensureSeeded();
    const versions = await this.policies.listVersions('breach');
    const now = Date.now();

    return BREACH_GATES.map((gate) => {
      const policyKey = breachPolicyKey(gate);
      // The same resolution rule the clock applies, over rows already fetched.
      const inForce = versions
        .filter((v) => v.policy_key === policyKey && v.effective_from.getTime() <= now)
        .sort(
          (a, b) => b.effective_from.getTime() - a.effective_from.getTime() || b.version - a.version,
        )[0];
      if (!inForce) {
        return {
          gate,
          policyKey,
          version: 0,
          slaSeconds: 0,
          slaHours: 0,
          effectiveFrom: new Date(0).toISOString(),
          note: null,
          isFallback: true,
        };
      }
      return {
        gate,
        policyKey,
        version: inForce.version,
        slaSeconds: inForce.sla_seconds,
        slaHours: Math.round((inForce.sla_seconds / 3600) * 100) / 100,
        effectiveFrom: inForce.effective_from.toISOString(),
        note: inForce.note,
        isFallback: false,
      };
    });
  }

  async supersedeDeadline(
    gate: BreachGate,
    input: {
      slaSeconds: number;
      ladder: EscalationLadderStep[];
      effectiveFrom: Date;
      note: string;
    },
  ) {
    const row = await this.policies.supersede({
      domain: 'breach',
      policyKey: breachPolicyKey(gate),
      slaSeconds: input.slaSeconds,
      ladder: input.ladder,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
    });
    return {
      gate,
      policyKey: row.policy_key,
      version: row.version,
      slaSeconds: row.sla_seconds,
      effectiveFrom: row.effective_from.toISOString(),
      note: row.note,
    };
  }

  // --- closure packet (FR-BRC-07) -----------------------------------------

  async closurePacket(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const [detail, user] = await Promise.all([this.detail(id), this.identity.currentUser()]);
    const generatedAt = new Date();
    const buffer = await renderClosurePacketPdf({
      organisationName: user.organisationName,
      generatedAt,
      detail,
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: id,
      reason: `Closure packet generated for ${detail.incident.referenceCode}`,
      afterState: {
        referenceCode: detail.incident.referenceCode,
        status: detail.incident.status,
        evidenceCount: detail.evidence.length,
        gatesCompleted: detail.gateStatuses.filter((g) => g.completedAt).length,
      },
    });

    return {
      buffer,
      filename: `Breach-Closure-${detail.incident.referenceCode}-${generatedAt.toISOString().slice(0, 10)}.pdf`,
    };
  }

  // --- internals -----------------------------------------------------------

  private async resolveCategories(entryIds: string[]): Promise<BreachDataCategory[]> {
    if (entryIds.length === 0) return [];
    const entries = await this.ropa.activeEntries();
    const wanted = new Set(entryIds);
    return entries
      .filter((e) => wanted.has(e.id))
      .map((e) => ({
        entryId: e.id,
        category: e.category,
        storageLocation: e.storage_location,
        purposes: e.purposes.map((p) => ({
          purposeName: p.purposeName,
          legalBasis: p.legalBasis,
          retentionPeriod: p.retentionPeriod,
        })),
      }));
  }

  private async requireIncident(client: PoolClient, id: string): Promise<IncidentRow> {
    const row = await this.repo.findById(client, id);
    if (!row) {
      throw new NotFoundException('Incident not found.');
    }
    return row;
  }
}

function mintReference(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join('');
  return `BRC-${pick()}-${pick()}`;
}

function toIncident(row: IncidentRow): BreachIncident {
  return {
    id: row.id,
    referenceCode: row.reference_code,
    title: row.title,
    whatHappened: row.what_happened,
    discoveredAt: row.discovered_at.toISOString(),
    occurredAt: row.occurred_at?.toISOString() ?? null,
    systemsAffected: row.systems_affected,
    estimatedAffectedCount: row.estimated_affected_count,
    severity: row.severity,
    currentGate: row.current_gate,
    status: row.status,
    closedAt: row.closed_at?.toISOString() ?? null,
    closureNote: row.closure_note,
    createdAt: row.created_at.toISOString(),
  };
}
