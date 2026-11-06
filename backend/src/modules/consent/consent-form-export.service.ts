import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditContextService } from '../audit/audit-context.service';
import { StorageService } from '../storage/storage.service';
import { SubmissionDeliveryService } from '../delivery/submission-delivery.service';
import { DataPrincipalService } from '../data-principal/data-principal.service';
import { ConsentFormsRepository } from './consent-forms.repository';
import { deriveDeliveryState } from './consent-delivery-state';
import { renderSubmissionsXlsx, type ExportField, type ExportSubmission } from './consent-form-export-xlsx';

/**
 * The submissions spreadsheet: build it, and point a form at an authorized
 * folder to keep it in.
 *
 * A SEPARATE service from ConsentFormsService on purpose — that one is the
 * write path for consent (it records events, stages deliveries, resolves
 * customers) and is already large. This one only READS what is already
 * recorded and renders it. It never writes a consent event, never touches a
 * submission row, and never deletes anything: generating an export cannot
 * alter the records it exports, which is the property that makes it safe to
 * expose as a repeatable action.
 *
 * It composes the existing services (R2): StorageService for destination
 * validation, SubmissionDeliveryService for delivery status, the forms
 * repository for everything else. It owns no table.
 */
@Injectable()
export class ConsentFormExportService {
  private readonly logger = new Logger(ConsentFormExportService.name);

  constructor(
    private readonly repo: ConsentFormsRepository,
    private readonly storage: StorageService,
    private readonly delivery: SubmissionDeliveryService,
    private readonly dataPrincipals: DataPrincipalService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * Renders this form's submissions, live. Never a cached snapshot: the sheet
   * reflects what is recorded at the moment it is generated, which is what
   * "reflect the latest authorized submissions" has to mean for a register
   * whose rows keep arriving.
   *
   * Tenant scoping is not done here and must not be: every repository call
   * runs inside the request's tenant context, so a form id belonging to
   * another tenant is indistinguishable from one that does not exist. The
   * role check is on the route.
   */
  async renderXlsx(formId: string): Promise<{ filename: string; buffer: Buffer }> {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');

    const [fields, rows, submissions, files] = await Promise.all([
      this.repo.listCustomerFields(formId),
      this.repo.listRows(formId, false),
      this.repo.listSubmissions(formId),
      this.repo.listSubmissionFiles(formId),
    ]);

    // Destination NAMES, resolved once. A name is what a customer recognises;
    // the root id stays out of the sheet entirely.
    const rootNames = new Map((await this.storage.listRoots(true)).map((r) => [r.id, r.name]));
    const filesBySubmission = new Map<string, ExportSubmission['files']>();
    for (const f of files) {
      const list = filesBySubmission.get(f.submission_id) ?? [];
      list.push({
        fieldLabel: f.field_label,
        filename: f.filename,
        byteSize: f.byte_size,
        contentType: f.content_type,
        destination: f.storage_root_id ? rootNames.get(f.storage_root_id) ?? null : null,
      });
      filesBySubmission.set(f.submission_id, list);
    }

    const statuses = await this.delivery.latestStatuses(submissions.map((s) => s.id));
    const centralConfigured = submissions.length > 0 ? await this.delivery.hasCentralDestination() : true;

    // The customer's display name, by subject_ref. Resolved metadata the
    // platform already holds (data_principals.display_name) — never the
    // subject_ref hash itself, and never a raw identifier value.
    const names = await this.dataPrincipals.displayNamesFor(submissions.map((s) => s.subject_ref));

    const exportSubmissions: ExportSubmission[] = submissions.map((s) => ({
      submittedAt: s.submitted_at instanceof Date ? s.submitted_at : new Date(s.submitted_at),
      channel: s.channel,
      customerName: names.get(s.subject_ref) ?? null,
      answers: s.answers.map((a) => ({ purposeName: a.consent_purpose_name ?? 'Consent', granted: a.granted })),
      files: filesBySubmission.get(s.id) ?? [],
      deliveryState: deriveDeliveryState({
        localSyncedAt: s.local_synced_at,
        deliveries: statuses.get(s.id) ?? [],
        centralConfigured,
      }).state,
    }));

    const exportFields: ExportField[] = fields
      .filter((f) => f.status === 'active')
      .map((f) => ({ label: f.label, isFile: f.field_type !== 'text' }));

    const buffer = await renderSubmissionsXlsx({
      organisationName: 'DPDP workspace',
      formName: form.name,
      generatedAt: new Date(),
      fields: exportFields,
      purposeNames: rows.filter((r) => r.status === 'active').map((r) => r.label),
      submissions: exportSubmissions,
    });

    this.audit.annotate({
      targetType: 'consent_form',
      targetId: formId,
      reason: `Submissions spreadsheet generated for "${form.name}" (${submissions.length} submission(s)).`,
      afterState: { submissions: submissions.length, files: files.length },
    });
    // Counts only. A form name is the client's own wording, and no customer
    // value, filename or destination ever reaches a log line.
    this.logger.log(`Submissions export rendered (form=${formId}, submissions=${submissions.length}).`);

    return { filename: exportFilename(form.name), buffer };
  }

  /**
   * Points this form's spreadsheet at an authorized WRITABLE folder, or
   * clears it.
   *
   * Revalidated here every time, never trusted from the request beyond the id:
   * the root must be this tenant's, active, and gateway-provider. A
   * gateway-provider root exists only because an administrator granted WRITE
   * on that folder (read grants are data_sources, a different registry
   * entirely), so a read-only folder cannot reach this setting — there is no
   * id that would pass.
   */
  async setExportDestination(formId: string, storageRootId: string | null) {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');

    let destinationName: string | null = null;
    if (storageRootId !== null) {
      // getRoot is tenant-scoped by RLS: another tenant's id throws NotFound.
      const root = await this.storage.getRoot(storageRootId);
      if (root.status !== 'active') {
        throw new ConflictException('That folder is no longer connected. Choose another one.');
      }
      if (root.provider !== 'gateway') {
        throw new BadRequestException('A spreadsheet can only be saved into a folder your Gateway writes to.');
      }
      destinationName = root.name;
    }

    const updated = await this.repo.setExportStorageRoot(formId, storageRootId);
    if (!updated) throw new NotFoundException('Consent form not found.');

    this.audit.annotate({
      targetType: 'consent_form',
      targetId: formId,
      reason: destinationName
        ? `Submissions spreadsheet destination set to "${destinationName}".`
        : 'Submissions spreadsheet destination cleared; download only.',
      beforeState: { exportStorageRootId: form.export_storage_root_id },
      afterState: { exportStorageRootId: storageRootId },
    });
    return { storageRootId, destinationName };
  }

  /**
   * Where this form's spreadsheet goes, for the management page — resolved to
   * a NAME plus whether it can be written right now. Returns the destination
   * as unavailable rather than silently falling back to download-only, so the
   * page can say the folder was removed and ask for a replacement.
   */
  async exportDestination(formId: string): Promise<{
    storageRootId: string | null;
    destinationName: string | null;
    available: boolean;
  }> {
    const form = await this.repo.getForm(formId);
    if (!form) throw new NotFoundException('Consent form not found.');
    if (!form.export_storage_root_id) return { storageRootId: null, destinationName: null, available: true };

    const root = (await this.storage.listRoots(true)).find((r) => r.id === form.export_storage_root_id);
    return {
      storageRootId: form.export_storage_root_id,
      destinationName: root?.name ?? null,
      available: !!root && root.status === 'active' && root.provider === 'gateway',
    };
  }
}

/**
 * A safe, recognisable filename. Built from the form's own name, which is
 * client-authored text and therefore untrusted for this purpose: anything
 * that is not a plain character becomes a hyphen, so no path separator,
 * traversal sequence, drive letter, quote or control character can reach a
 * Content-Disposition header or a Gateway write.
 */
export function exportFilename(formName: string, now = new Date()): string {
  const stem = formName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 60);
  const date = now.toISOString().slice(0, 10);
  return `${stem || 'consent-form'} submissions ${date}.xlsx`;
}
