import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { EntryPurposesService } from '../inventory/entry-purposes.service';
import { ConsentService } from './consent.service';
import { ConsentNoticesService } from './consent-notices.service';
import { SubjectRefHasher } from './subject-ref';
import { ConsentFormsRepository, type FormRow } from './consent-forms.repository';
import { ConsentInventoryLinkRepository } from './consent-inventory-link.repository';
import type { AddRowInput, LinkSubmissionInput, SaveFormInput, UpdateRowInput, WidgetSubmissionInput } from './consent-forms.dto';

const EN = 'en';

/**
 * The new-UX consent form builder. A form is a name + a mutable flat list of
 * "consent rows"; each row is a typed label + a short notice sentence + an
 * active toggle + an optional Data Inventory element link, and BEHIND THE SCENES
 * resolves to a real, versioned consent_purpose + consent_notice_version — the
 * user never visits a separate Purposes or Notices screen.
 *
 * Every submission (site-wide embed OR per-form hosted link) still goes through
 * ConsentService.recordConsent() — the same single write path (R3) — so a
 * form-driven grant is an ordinary consent_event carrying the exact notice
 * version the row showed. Proof-of-consent is unchanged.
 */
@Injectable()
export class ConsentFormsService {
  constructor(
    private readonly repo: ConsentFormsRepository,
    private readonly consent: ConsentService,
    private readonly notices: ConsentNoticesService,
    private readonly subjectRef: SubjectRefHasher,
    private readonly entryPurposes: EntryPurposesService,
    private readonly inventoryLinks: ConsentInventoryLinkRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  // --- staff: forms ----------------------------------------------------------

  async createForm(input: SaveFormInput) {
    const ctx = this.tenantContext.getOrThrow();
    const form = await this.repo.createForm({
      name: input.name,
      description: input.description,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'consent_form',
      targetId: form.id,
      reason: `Consent form "${input.name}" created.`,
      afterState: { name: input.name },
    });
    return this.getForm(form.id);
  }

  async updateForm(formId: string, input: SaveFormInput) {
    const form = await this.repo.updateForm(formId, { name: input.name, description: input.description });
    if (!form) throw new NotFoundException('Consent form not found.');
    this.audit.annotate({
      targetType: 'consent_form',
      targetId: formId,
      reason: `Consent form renamed to "${input.name}".`,
      afterState: { name: input.name },
    });
    return this.getForm(formId);
  }

  async setActive(formId: string, isActive: boolean) {
    const form = await this.repo.setFormActive(formId, isActive);
    if (!form) throw new NotFoundException('Consent form not found.');
    this.audit.annotate({
      targetType: 'consent_form',
      targetId: formId,
      reason: `Consent form ${isActive ? 'activated (now live on the website embed and its link)' : 'deactivated (removed from the live embed and its link)'}.`,
      beforeState: { isActive: !isActive },
      afterState: { isActive },
    });
    return this.getForm(formId);
  }

  async list() {
    const forms = await this.repo.listForms();
    return forms.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      slug: f.slug,
      isActive: f.is_active,
      rowCount: f.row_count,
      activeRowCount: f.active_row_count,
      submissionCount: f.submission_count,
      updatedAt: f.updated_at,
    }));
  }

  async getForm(formId: string) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');
    const rows = await this.repo.listRows(formId, false);
    return {
      id: form.id,
      name: form.name,
      description: form.description,
      slug: form.slug,
      isActive: form.is_active,
      rows: rows.map(toRowResponse),
    };
  }

  // --- staff: rows -----------------------------------------------------------

  async addRow(formId: string, input: AddRowInput) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');

    const { consentPurposeId, noticeVersionId } = await this.resolvePurposeAndNotice(input.label, input.noticeText);
    const displayOrder = await this.repo.nextDisplayOrder(formId);

    let row: FormRow;
    try {
      row = await this.repo.addRow({
        formId,
        consentPurposeId,
        noticeVersionId,
        label: input.label,
        noticeText: input.noticeText,
        inventoryEntryId: input.inventoryEntryId,
        displayOrder,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('This form already has a row for that purpose.');
      }
      throw err;
    }

    if (input.inventoryEntryId) {
      await this.linkInventory(consentPurposeId, input.inventoryEntryId);
    }
    if (input.active === false) {
      await this.repo.setRowActive(row.id, false);
      row = { ...row, active: false };
    }

    this.audit.annotate({
      targetType: 'consent_form_row',
      targetId: row.id,
      reason: `Consent row "${input.label}" added to a form${input.inventoryEntryId ? ' and linked to a Data Inventory element' : ''}.`,
      afterState: { formId, consentPurposeId, inventoryEntryId: input.inventoryEntryId },
    });
    return this.getForm(formId);
  }

  async updateRow(formId: string, rowId: string, input: UpdateRowInput) {
    const { consentPurposeId, noticeVersionId } = await this.resolvePurposeAndNotice(input.label, input.noticeText);
    const row = await this.repo.updateRow(rowId, {
      label: input.label,
      noticeText: input.noticeText,
      noticeVersionId,
      inventoryEntryId: input.inventoryEntryId,
    });
    if (!row) throw new NotFoundException('Consent row not found.');
    if (input.inventoryEntryId) {
      await this.linkInventory(consentPurposeId, input.inventoryEntryId);
    }
    this.audit.annotate({
      targetType: 'consent_form_row',
      targetId: rowId,
      reason: `Consent row "${input.label}" edited.`,
      afterState: { noticeVersionId, inventoryEntryId: input.inventoryEntryId },
    });
    return this.getForm(formId);
  }

  async toggleRow(formId: string, rowId: string, active: boolean) {
    const row = await this.repo.setRowActive(rowId, active);
    if (!row) throw new NotFoundException('Consent row not found.');
    this.audit.annotate({
      targetType: 'consent_form_row',
      targetId: rowId,
      reason: `Consent row "${row.label}" ${active ? 'activated' : 'deactivated'}.`,
      afterState: { active },
    });
    return this.getForm(formId);
  }

  async removeRow(formId: string, rowId: string) {
    const removed = await this.repo.removeRow(rowId);
    if (!removed) throw new NotFoundException('Consent row not found or already removed.');
    this.audit.annotate({
      targetType: 'consent_form_row',
      targetId: rowId,
      reason: 'Consent row removed from a form.',
      afterState: { status: 'removed' },
    });
    return this.getForm(formId);
  }

  async listSubmissions(formId: string) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');
    const submissions = await this.repo.listSubmissions(formId);
    return submissions.map((s) => ({
      id: s.id,
      channel: s.channel,
      submittedAt: s.submitted_at,
      subjectRef: s.subject_ref,
      answers: s.answers.map((a) => ({
        consentPurposeId: a.consent_purpose_id,
        purposeName: a.consent_purpose_name,
        granted: a.granted,
      })),
    }));
  }

  // --- public: the tenant-wide embed + the per-form hosted link --------------

  /** The one read the site-wide embed makes: every live form with its active
   *  rows. Toggling a form or row active/inactive changes this with no client
   *  code change. */
  async activeFormsForTenant() {
    const forms = await this.repo.activeFormsWithRows();
    return forms.map(({ form, rows }) => ({
      formId: form.id,
      name: form.name,
      description: form.description,
      rows: rows.map(toPublicRow),
    }));
  }

  /** The per-form hosted link (by resolved form id). 404s unless the form is
   *  active and has active rows. */
  async publicFormForLink(formId: string) {
    const form = await this.repo.getForm(formId);
    if (!form || !form.is_active) {
      throw new NotFoundException('This form is not currently available.');
    }
    const rows = await this.repo.listRows(formId, true);
    if (rows.length === 0) {
      throw new NotFoundException('This form has no active rows.');
    }
    return { formId: form.id, name: form.name, description: form.description, rows: rows.map(toPublicRow) };
  }

  async submitWidget(formId: string, input: WidgetSubmissionInput) {
    return this.submit(formId, 'widget', input.customerId, input.answers);
  }

  async submitLink(formId: string, input: LinkSubmissionInput) {
    const customerId = input.email ? input.email.trim().toLowerCase() : input.phone!.trim();
    return this.submit(formId, 'link', customerId, input.answers);
  }

  private async submit(
    formId: string,
    channel: 'widget' | 'link',
    customerId: string,
    answers: Array<{ consentPurposeId: string; granted: boolean }>,
  ) {
    const form = await this.repo.getForm(formId);
    if (!form || !form.is_active) {
      throw new NotFoundException('This form is not currently available.');
    }
    const rows = await this.repo.listRows(formId, true);
    const byPurpose = new Map(rows.map((r) => [r.consent_purpose_id, r]));
    for (const a of answers) {
      if (!byPurpose.has(a.consentPurposeId)) {
        throw new BadRequestException('An answer refers to a row that is not active on this form.');
      }
    }

    const ctx = this.tenantContext.getOrThrow();
    const subjectRef = await this.subjectRef.hash(ctx.tenantId, customerId);
    const occurredAt = new Date().toISOString();
    const recorded: Array<{ consentPurposeId: string; granted: boolean; consentEventId: string | null; noticeVersionId: string }> = [];

    for (const a of answers) {
      const row = byPurpose.get(a.consentPurposeId)!;
      if (!a.granted) {
        recorded.push({ consentPurposeId: a.consentPurposeId, granted: false, consentEventId: null, noticeVersionId: row.notice_version_id });
        continue;
      }
      const { receipt } = await this.consent.recordConsent({
        customerId,
        purposeId: row.consent_purpose_id,
        status: 'GRANTED',
        noticeVersionId: row.notice_version_id,
        occurredAt,
        source: channel === 'widget' ? 'web_sdk' : 'portal',
        idempotencyKey: `consent-form:${formId}:${subjectRef}:${row.consent_purpose_id}:${row.notice_version_id}`,
      });
      recorded.push({
        consentPurposeId: a.consentPurposeId,
        granted: true,
        consentEventId: receipt.eventId,
        noticeVersionId: row.notice_version_id,
      });
    }

    const submission = await this.repo.createSubmission({ formId, subjectRef, channel, answers: recorded });
    this.audit.annotate({
      actorLabel: channel === 'widget' ? 'consent_form:widget' : 'consent_form:link',
      targetType: 'consent_form_submission',
      targetId: submission.id,
      reason: `Consent form submitted (${channel}) — ${recorded.filter((r) => r.granted).length}/${recorded.length} granted.`,
      afterState: { formId, channel },
    });
    return { submissionId: submission.id, subjectRef, answers: recorded.map((r) => ({ consentPurposeId: r.consentPurposeId, granted: r.granted })) };
  }

  // --- the "behind the scenes" resolution ------------------------------------

  /** Reuse an existing consent purpose with this exact label, else create one;
   *  then reuse its current notice version if the text is unchanged, else
   *  publish a new one. This is what lets the builder be a single screen. */
  private async resolvePurposeAndNotice(label: string, noticeText: string): Promise<{ consentPurposeId: string; noticeVersionId: string }> {
    const purposes = await this.consent.listPurposes(false);
    const existing = purposes.find((p) => p.name.trim().toLowerCase() === label.trim().toLowerCase());
    const consentPurposeId = existing
      ? existing.id
      : (await this.consent.createPurpose({ name: label, description: null })).purpose.id;

    // Reuse the latest notice version if its English body already matches.
    const notices = await this.notices.listForPurpose(consentPurposeId);
    const latest = notices[0];
    const latestEn = latest?.translations.find((t) => t.language === EN);
    if (latest && latestEn && latestEn.body === noticeText) {
      return { consentPurposeId, noticeVersionId: latest.version.id };
    }
    const published = await this.notices.create(consentPurposeId, [{ language: EN, body: noticeText }]);
    return { consentPurposeId, noticeVersionId: published.version.id };
  }

  /** Link the row's purpose to every active inventory purpose of the chosen
   *  element, so Tier-1 PDS attributes that element to this consent (Prompt 32
   *  bridge, reused). */
  private async linkInventory(consentPurposeId: string, inventoryEntryId: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    const purposes = await this.entryPurposes.listForEntry(inventoryEntryId, false);
    const inventoryPurposeIds = purposes.map((p) => p.id);
    await this.inventoryLinks.linkPurposeToInventoryPurposes(consentPurposeId, inventoryPurposeIds, ctx.userId);
  }
}

function toRowResponse(r: FormRow) {
  return {
    id: r.id,
    label: r.label,
    noticeText: r.notice_text,
    consentPurposeId: r.consent_purpose_id,
    noticeVersionId: r.notice_version_id,
    inventoryEntryId: r.inventory_entry_id,
    inventoryEntryCategory: r.inventory_entry_category,
    active: r.active,
    displayOrder: r.display_order,
  };
}

function toPublicRow(r: FormRow) {
  return {
    consentPurposeId: r.consent_purpose_id,
    label: r.label,
    noticeText: r.notice_text,
    noticeVersionId: r.notice_version_id,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
