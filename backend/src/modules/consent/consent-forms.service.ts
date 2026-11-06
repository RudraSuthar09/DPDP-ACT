import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { EntryPurposesService } from '../inventory/entry-purposes.service';
import { ConsentService } from './consent.service';
import { ConsentNoticesService } from './consent-notices.service';
import { SubjectRefHasher } from './subject-ref';
import { ConsentFormsRepository, type CustomerFieldRow, type FormRow } from './consent-forms.repository';
import { ConsentInventoryLinkRepository } from './consent-inventory-link.repository';
import { DataPrincipalService } from '../data-principal/data-principal.service';
import { EnterpriseStorageSyncService, type FieldValueToWrite } from '../storage-sync/enterprise-storage-sync.service';
import { SubmissionDeliveryService, type StageDeliveryFieldInput } from '../delivery/submission-delivery.service';
import { deriveDeliveryState } from './consent-delivery-state';
import { acceptUpload, isTypeCheckedUpload, uploadRulesFor, type AcceptedUpload } from './consent-form-uploads';
import { enterpriseCopyFilename } from '../delivery/submission-delivery.service';
import type {
  AddRowInput,
  LinkSubmissionFieldValueInput,
  LinkSubmissionInput,
  SaveCustomerFieldDtoInput,
  SaveFormInput,
  UpdateRowInput,
  WidgetSubmissionInput,
} from './consent-forms.dto';

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
  private readonly logger = new Logger(ConsentFormsService.name);

  constructor(
    private readonly repo: ConsentFormsRepository,
    private readonly consent: ConsentService,
    private readonly notices: ConsentNoticesService,
    private readonly subjectRef: SubjectRefHasher,
    private readonly entryPurposes: EntryPurposesService,
    private readonly inventoryLinks: ConsentInventoryLinkRepository,
    private readonly dataPrincipals: DataPrincipalService,
    private readonly enterpriseSync: EnterpriseStorageSyncService,
    private readonly delivery: SubmissionDeliveryService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  // --- staff: forms ----------------------------------------------------------

  async createForm(input: SaveFormInput) {
    const ctx = this.tenantContext.getOrThrow();
    const form = await this.repo.createForm({
      name: input.name,
      description: input.description,
      retentionMonths: input.retentionMonths,
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
    const form = await this.repo.updateForm(formId, {
      name: input.name,
      description: input.description,
      noticeText: input.noticeText,
      retentionMonths: input.retentionMonths,
    });
    if (!form) throw new NotFoundException('Consent form not found.');
    this.audit.annotate({
      targetType: 'consent_form',
      targetId: formId,
      reason: `Consent form "${input.name}" updated.`,
      afterState: { name: input.name, hasNoticeText: !!input.noticeText, retentionMonths: input.retentionMonths },
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
      retentionMonths: f.retention_months,
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
    const customerFields = await this.repo.listCustomerFields(formId);
    return {
      id: form.id,
      name: form.name,
      description: form.description,
      noticeText: form.notice_text,
      slug: form.slug,
      isActive: form.is_active,
      /** Central DPDP Storage simplification: months to retain this
       *  template's consent data in the client's local storage, or null if
       *  not configured. */
      retentionMonths: form.retention_months,
      rows: rows.map(toRowResponse),
      customerFields: customerFields.map(toCustomerFieldResponse),
    };
  }

  // --- Form fields — a simple, Google-Forms-like field list -------------------
  //
  // A field is CONFIGURATION ONLY: label/type/required, nothing else. Nothing
  // here reads, writes, or stores a submitted VALUE — the browser writes that
  // directly to Central DPDP Storage (and, if configured, the field's own
  // additional local folder via storage_mappings module_key
  // 'consent_form_field') without it ever reaching this service or PostgreSQL.

  async addCustomerField(formId: string, input: SaveCustomerFieldDtoInput) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');
    const displayOrder = await this.repo.nextCustomerFieldDisplayOrder(formId);
    let field;
    try {
      field = await this.repo.addCustomerField({ formId, displayOrder, ...input });
    } catch (err) {
      throw toFieldConflictError(err);
    }
    this.audit.annotate({
      targetType: 'consent_form_customer_field',
      targetId: field.id,
      reason: `Field "${input.label}" added (type: ${input.fieldType}${input.isIdentifier ? ', identifier' : ''}${input.isCustomerName ? ', customer name' : ''}).`,
      afterState: { label: input.label, fieldType: input.fieldType, required: input.required, isIdentifier: input.isIdentifier, isCustomerName: input.isCustomerName },
    });
    return this.getForm(formId);
  }

  async updateCustomerField(formId: string, fieldId: string, input: SaveCustomerFieldDtoInput) {
    let field;
    try {
      field = await this.repo.updateCustomerField(fieldId, input);
    } catch (err) {
      throw toFieldConflictError(err);
    }
    if (!field) throw new NotFoundException('Field not found.');
    this.audit.annotate({
      targetType: 'consent_form_customer_field',
      targetId: fieldId,
      reason: `Field "${input.label}" edited (type: ${input.fieldType}${input.isIdentifier ? ', identifier' : ''}${input.isCustomerName ? ', customer name' : ''}).`,
      afterState: { label: input.label, fieldType: input.fieldType, required: input.required, isIdentifier: input.isIdentifier, isCustomerName: input.isCustomerName },
    });
    return this.getForm(formId);
  }

  async removeCustomerField(formId: string, fieldId: string) {
    const removed = await this.repo.removeCustomerField(fieldId);
    if (!removed) throw new NotFoundException('Field not found or already removed.');
    this.audit.annotate({
      targetType: 'consent_form_customer_field',
      targetId: fieldId,
      reason: 'Field removed from a form.',
      afterState: { status: 'removed' },
    });
    return this.getForm(formId);
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
    // Delivery lifecycle comes from the delivery module's own service (R2 —
    // never a join into its table from here). Metadata only.
    const deliveries = await this.delivery.latestStatuses(submissions.map((s) => s.id));
    const centralConfigured = submissions.length > 0 ? await this.delivery.hasCentralDestination() : true;
    return submissions.map((s) => {
      const derived = deriveDeliveryState({ localSyncedAt: s.local_synced_at, deliveries: deliveries.get(s.id) ?? [], centralConfigured });
      return {
        id: s.id,
        channel: s.channel,
        submittedAt: s.submitted_at,
        subjectRef: s.subject_ref,
        answers: s.answers.map((a) => ({
          consentPurposeId: a.consent_purpose_id,
          purposeName: a.consent_purpose_name,
          granted: a.granted,
        })),
        deliveryState: derived.state,
        // Attempts so far on whatever is still being retried (0 = none) —
        // lets the view say "retrying" without exposing any error text.
        deliveryAttempts: derived.retryAttempts,
        // Per destination, counts/outcomes only — never a path or name.
        centralDelivery: derived.central,
        enterpriseCopies: derived.enterpriseCopies,
      };
    });
  }

  /** Submissions this template's consent data has not yet been written into
   *  the client's local storage for — the Storage page's sync routine reads
   *  this, writes the file(s) itself (browser-side, this service never
   *  touches a filesystem), then calls markSubmissionSynced. Never a raw
   *  customer name/id — subjectRef only, exactly like listSubmissions (I2). */
  async listPendingLocalSync(formId: string) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');
    const submissions = await this.repo.listPendingLocalSync(formId);
    return Promise.all(
      submissions.map(async (s) => {
        // Resolves (never re-creates — every one of these was already
        // resolved once at submit time) the same internal customer UUID +
        // display name the Storage page's deferred sync needs for
        // resolveCustomerFolder's folder-naming.
        const { customerId, displayName } = await this.dataPrincipals.resolve(s.subject_ref);
        return {
          id: s.id,
          channel: s.channel,
          submittedAt: s.submitted_at,
          subjectRef: s.subject_ref,
          customerId,
          displayName,
          answers: s.answers.map((a) => ({
            consentPurposeId: a.consent_purpose_id,
            purposeName: a.consent_purpose_name,
            granted: a.granted,
          })),
        };
      }),
    );
  }

  async markSubmissionSynced(formId: string, submissionId: string) {
    const ok = await this.repo.markSubmissionSynced(formId, submissionId);
    if (!ok) throw new NotFoundException('Consent form submission not found.');
    this.audit.annotate({
      targetType: 'consent_form_submission',
      targetId: submissionId,
      reason: 'Consent submission written into local storage.',
      afterState: { locallySynced: true },
    });
    return { synced: true };
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
      noticeText: form.notice_text,
      rows: rows.map(toPublicRow),
    }));
  }

  /** The per-form hosted link (by resolved form id). 404s unless the form is
   *  active and has active rows. */
  async publicFormForLink(formId: string) {
    const form = await this.repo.getForm(formId);
    // Each refusal carries a stable `reason` as well as its message: the
    // public page tells the visitor which of these actually happened, instead
    // of showing "we couldn't find that form" for all of them. The reason
    // names no tenant, no form content and no id.
    if (!form || !form.is_active) {
      throw new NotFoundException({ message: 'This form is not currently available.', reason: 'FORM_NOT_LIVE' });
    }
    const rows = await this.repo.listRows(formId, true);
    if (rows.length === 0) {
      throw new NotFoundException({ message: 'This form has no active consent items yet.', reason: 'FORM_NOT_READY' });
    }
    const customerFields = await this.repo.listCustomerFields(formId);
    return {
      formId: form.id,
      name: form.name,
      description: form.description,
      noticeText: form.notice_text,
      // Configuration only, for the local Customer Information/retention.json
      // the browser writes on submit — never enforced/deleted here.
      retentionMonths: form.retention_months,
      rows: rows.map(toPublicRow),
      // Field CONFIGURATION only (id/label/type/required/isIdentifier) —
      // never a value. The public page renders one input per field; the
      // browser writes whatever the visitor types/uploads straight to local
      // storage on submit, never through this backend (I1) — UNLESS
      // hasServerStorage below is true, in which case the frontend also
      // sends field VALUES on submit, for the synchronous Enterprise write
      // (see EnterpriseStorageSyncService). Absent/false for every tenant
      // without a 'server' storage root — I1 unchanged for them.
      fields: customerFields.map(toCustomerFieldResponse),
      hasServerStorage: await this.enterpriseSync.hasActiveServerRoot(),
    };
  }

  async submitWidget(formId: string, input: WidgetSubmissionInput) {
    return this.submit(formId, 'widget', input.customerId, null, input.answers, []);
  }

  async submitLink(formId: string, input: LinkSubmissionInput) {
    // No hardcoded Name/Email/Phone any more — the client marks ONE of their
    // own configured fields "Use as Customer Identifier" (is_identifier) and
    // its value rides here as identityValue. No identifier field configured
    // (or the visitor left it blank) is legitimate, not an error: a fresh,
    // never-repeating id means this submission simply won't be recognised as
    // a repeat customer later — correct, not a failure.
    const customerId = input.identityValue?.trim() || randomUUID();
    return this.submit(formId, 'link', customerId, input.customerNameValue, input.answers, input.fieldValues);
  }

  private async submit(
    formId: string,
    channel: 'widget' | 'link',
    customerId: string,
    customerNameValue: string | null,
    answers: Array<{ consentPurposeId: string; granted: boolean }>,
    fieldValues: LinkSubmissionFieldValueInput[],
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

    // UPLOADS ARE VALIDATED FIRST, before a single consent event is written.
    // The file's real type, size and extension are re-derived from the bytes
    // (acceptUpload) against the FIELD's own configuration, never against
    // anything in this request. A refusal throws, so the respondent is told
    // what is wrong and nothing is recorded — the alternative, recording the
    // consent and dropping the file, would leave the client holding a consent
    // whose evidence silently never arrived.
    const accepted = this.validateUploads(await this.repo.listCustomerFields(formId), fieldValues);

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

    // The internal customer UUID — never subject_ref itself, and never the
    // raw `customerId` parameter above (that's the pre-hash identity value,
    // e.g. an email) — resolved from the SAME subject_ref every other
    // consent write for this person uses. The SAME person submitting again
    // always resolves to the SAME internalCustomerId;
    // storage_mappings.entity_id (moduleKey 'data_principal') uses ONLY
    // this value, never the 64-character subject_ref hash.
    //
    // displayName is the customer's human-readable name — from whichever
    // field the client marked "Use as Customer Name" (may be a DIFFERENT
    // field than the identifier, or the same one, or none). Used ONLY for
    // filesystem folder naming (never identity); COALESCEd server-side so a
    // submission with no name doesn't blank out one a prior submission set.
    const { customerId: internalCustomerId, displayName } = await this.dataPrincipals.resolve(
      subjectRef,
      customerNameValue?.trim() || null,
    );

    // Enterprise Central DPDP Storage automatic sync: SYNCHRONOUS, best-
    // effort, never fails the submission itself. No-ops instantly (synced:
    // false) for every tenant without a 'server' storage root configured —
    // see EnterpriseStorageSyncService's header for why this cannot be
    // deferred/retried with the real field bytes later (CLAUDE.md R6).
    //
    // Computed BEFORE the one audit.annotate() call below (not a second,
    // later call) — AuditContextService.annotate() does a shallow
    // Object.assign per request, so a second call would silently overwrite
    // this one's reason/afterState instead of adding to them.
    const syncResult =
      fieldValues.length > 0
        ? await this.writeEnterpriseFieldsNow(formId, submission.id, internalCustomerId, subjectRef, displayName, fieldValues)
        : null;

    // Cloud relay staging: ONLY when the synchronous Enterprise-server write
    // did not already deliver these values (either no 'server' root is
    // configured at all — the SaaS/Electron-local case this exists for — or
    // it was configured but unreachable right now). Never a second, redundant
    // delivery path for a tenant whose synchronous write just succeeded. See
    // SubmissionDeliveryService's header for why this table exists at all
    // (a deliberate, documented CLAUDE.md I1/R6 exception) and why staging
    // here is additive, not a replacement for the untouched Enterprise sync
    // call above.
    if (fieldValues.length > 0 && !syncResult?.synced) {
      await this.stageFieldsForDelivery(formId, submission.id, internalCustomerId, subjectRef, displayName, fieldValues);
    }

    // Enterprise COPIES (additional to everything above, which is unchanged):
    // fields whose Additional Storage mapping points at a Gateway-authorized
    // folder are queued for the Gateway, independently of whether the Central
    // write above succeeded. The destination is resolved from the tenant's
    // own mappings, never from this request.
    const enterpriseCopies = fieldValues.length > 0 ? await this.stageEnterpriseCopies(formId, submission.id, fieldValues, accepted) : 0;

    // Durable METADATA about each file collected — label, the filename this
    // server generated, size, the proved content type. The delivery payload
    // is nulled on acknowledgement by design, so without this the platform
    // would forget a file was ever collected the moment it was safely
    // delivered, and could neither list it in an export nor tell an auditor
    // it existed. No bytes, no customer path. Best-effort: a submission that
    // is already recorded must never fail because its bookkeeping did.
    for (const file of accepted) {
      try {
        await this.repo.recordSubmissionFile({
          submissionId: submission.id,
          formId,
          fieldId: file.fieldId,
          fieldLabel: file.label,
          filename: enterpriseCopyFilename({
            submissionId: submission.id,
            fieldId: file.fieldId,
            label: file.label,
            originalFilename: null,
            extension: file.extension,
          }),
          byteSize: file.byteSize,
          contentType: file.contentType,
          storageRootId: null,
        });
      } catch (err) {
        this.logger.warn(
          `Could not record file metadata for a submission (form=${formId}): ${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }

    this.audit.annotate({
      actorLabel: channel === 'widget' ? 'consent_form:widget' : 'consent_form:link',
      targetType: 'consent_form_submission',
      targetId: submission.id,
      reason:
        `Consent form submitted (${channel}) — ${recorded.filter((r) => r.granted).length}/${recorded.length} granted.` +
        (syncResult?.synced ? ' Written into Enterprise Central DPDP Storage.' : ''),
      afterState: {
        formId,
        channel,
        ...(syncResult ? { enterpriseSynced: syncResult.synced } : {}),
        ...(enterpriseCopies > 0 ? { enterpriseCopiesQueued: enterpriseCopies } : {}),
      },
    });

    return {
      submissionId: submission.id,
      subjectRef,
      customerId: internalCustomerId,
      displayName,
      answers: recorded.map((r) => ({ consentPurposeId: r.consentPurposeId, granted: r.granted })),
    };
  }

  /** Returns `{ synced: false }` (never throws) whenever there is nothing to
   *  write or the write failed — the caller folds this into the SAME single
   *  audit.annotate() call as the submission itself, never a second one. */
  private async writeEnterpriseFieldsNow(
    formId: string,
    submissionId: string,
    customerId: string,
    subjectRef: string,
    displayName: string | null,
    fieldValues: LinkSubmissionFieldValueInput[],
  ): Promise<{ synced: boolean }> {
    const form = await this.repo.getForm(formId);
    const customerFields = await this.repo.listCustomerFields(formId);
    const byId = new Map(customerFields.map((f) => [f.id, f]));

    const fields: FieldValueToWrite[] = [];
    for (const v of fieldValues) {
      const field = byId.get(v.fieldId);
      if (!field) continue; // an unknown/removed field id — ignore rather than fail the submission
      if (v.file) {
        fields.push({ label: field.label, file: { filename: v.file.filename, bytes: Buffer.from(v.file.contentBase64, 'base64') } });
      } else if (v.textValue !== undefined) {
        fields.push({ label: field.label, textValue: v.textValue });
      }
    }
    if (fields.length === 0) return { synced: false };

    // The resolved Customer Name (data_principals.display_name) — never the
    // identifier's raw value (an email is not a folder name). Falls back to
    // a UUID-derived label only when no "Customer Name" field is configured.
    const displayNameHint = displayName?.trim() || `customer-${customerId.slice(0, 8)}`;

    const { success } = await this.enterpriseSync.writeSubmissionFieldsNow({
      customerId,
      subjectRef,
      displayNameHint,
      templateName: form!.name,
      retentionMonths: form!.retention_months,
      fields,
    });

    if (success) {
      await this.repo.markSubmissionSynced(formId, submissionId);
    }
    // On failure: local_synced_at stays NULL. The worker's periodic sweep can
    // later recover Customer Information, but NOT these field values — they
    // existed only in this request's memory (R6). Logged inside
    // EnterpriseStorageSyncService; the consent GRANT itself is unaffected.
    return { synced: success };
  }

  /** Stages field values for the cloud delivery queue — see the call site's
   *  comment and SubmissionDeliveryService's header. Reuses the exact same
   *  field-id -> label resolution as writeEnterpriseFieldsNow above (never a
   *  second, divergent copy of that lookup). Never throws: staging is
   *  best-effort, exactly like the synchronous Enterprise write it backs up. */
  private async stageFieldsForDelivery(
    formId: string,
    submissionId: string,
    customerId: string,
    subjectRef: string,
    displayName: string | null,
    fieldValues: LinkSubmissionFieldValueInput[],
  ): Promise<void> {
    const form = await this.repo.getForm(formId);
    const customerFields = await this.repo.listCustomerFields(formId);
    const byId = new Map(customerFields.map((f) => [f.id, f]));

    const fields: StageDeliveryFieldInput[] = [];
    for (const v of fieldValues) {
      const field = byId.get(v.fieldId);
      if (!field) continue;
      if (v.file) {
        fields.push({ label: field.label, file: { filename: v.file.filename, contentBase64: v.file.contentBase64 } });
      } else if (v.textValue !== undefined && v.textValue.trim().length > 0) {
        fields.push({ label: field.label, textValue: v.textValue });
      }
    }
    if (fields.length === 0) return;

    await this.delivery.stage({
      submissionId,
      formId,
      customerId,
      subjectRef,
      displayName,
      templateName: form!.name,
      retentionMonths: form!.retention_months,
      fields,
    });
  }

  /** Same field-id -> label resolution as stageFieldsForDelivery above (only
   *  fields that are still on this form), handed to the delivery module,
   *  which owns the mapping lookup and the encrypted staging. Returns how
   *  many destinations were queued. Never throws. */
  /**
   * Checks every submitted file against ITS OWN field's configuration and
   * returns what was accepted. Throws on the first refusal.
   *
   * A value sent for a field that does not exist (or was removed) is ignored
   * rather than fatal — the same tolerance the rest of this path already has
   * for a form edited while someone had it open. A file sent for a TEXT field
   * is a refusal, though: that is a caller doing something the form never
   * offered.
   */
  private validateUploads(
    customerFields: Array<{ id: string; label: string; field_type: string; allowed_file_kinds: string | null; max_file_bytes: number | null }>,
    fieldValues: LinkSubmissionFieldValueInput[],
  ): AcceptedUpload[] {
    const byId = new Map(customerFields.map((f) => [f.id, f]));
    const out: AcceptedUpload[] = [];
    for (const v of fieldValues) {
      if (!v.file) continue;
      const field = byId.get(v.fieldId);
      if (!field) continue;
      // Only a TEXT field refuses a file outright. Every other type is an
      // upload type, and an absent/unknown type is treated as one too rather
      // than failing a submission — field_type is NOT NULL with a default in
      // the schema, so an unknown value here means something changed under
      // us, and the byte check below is what actually guards the content.
      if (field.field_type === 'text') {
        throw new BadRequestException(`"${field.label}" does not accept a file.`);
      }
      // The legacy 'excel' type is outside the byte allowlist by design (a
      // .xlsx is a zip container) — it keeps exactly the behaviour it had
      // before uploads were type-checked, rather than breaking live forms.
      if (!isTypeCheckedUpload(field.field_type)) continue;
      out.push(acceptUpload(uploadRulesFor(field), v.file.contentBase64));
    }
    return out;
  }

  private async stageEnterpriseCopies(
    formId: string,
    submissionId: string,
    fieldValues: LinkSubmissionFieldValueInput[],
    accepted: AcceptedUpload[] = [],
  ): Promise<number> {
    const customerFields = await this.repo.listCustomerFields(formId);
    const byId = new Map(customerFields.map((f) => [f.id, f]));
    // The extension PROVED from each file's bytes, so the name written into
    // the client's folder reflects what the file actually is rather than what
    // the respondent called it.
    const provedExtension = new Map(accepted.map((a) => [a.fieldId, a.extension]));
    const fields = fieldValues.flatMap((v) => {
      const field = byId.get(v.fieldId);
      if (!field) return [];
      return [
        {
          fieldId: field.id,
          label: field.label,
          ...(v.file
            ? { file: { ...v.file, extension: provedExtension.get(field.id) ?? null } }
            : { textValue: v.textValue }),
        },
      ];
    });
    if (fields.length === 0) return 0;
    return this.delivery.stageEnterpriseCopies({ submissionId, formId, fields });
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

function toCustomerFieldResponse(f: CustomerFieldRow) {
  return {
    id: f.id,
    formId: f.form_id,
    label: f.label,
    fieldType: f.field_type,
    required: f.required,
    isIdentifier: f.is_identifier,
    isCustomerName: f.is_customer_name,
    displayOrder: f.display_order,
    description: f.description,
    // Upload configuration. Safe to send to the PUBLIC form: it is what the
    // respondent must be told anyway ("JPG, PNG or PDF, up to 10 MB"), and
    // neither value is a secret or a server-side decision the client could
    // subvert by editing it — the backend re-checks both against the stored
    // field, never against the request.
    allowedFileKinds: f.allowed_file_kinds,
    maxFileBytes: f.max_file_bytes,
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

/** Distinguishes WHICH one-per-form rule a customer-field save tripped
 *  (identifier vs customer-name) via the violated constraint's name, so the
 *  client gets an accurate message instead of always blaming the identifier. */
function toFieldConflictError(err: unknown): Error {
  if (!isUniqueViolation(err)) return err as Error;
  const constraint = (err as { constraint?: string }).constraint ?? '';
  if (constraint.includes('customer_name')) {
    return new BadRequestException('This form already has a Customer Name field — uncheck it there first.');
  }
  return new BadRequestException('This form already has a Customer Identifier field — uncheck it there first.');
}
