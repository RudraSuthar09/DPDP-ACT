import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { TenantDatabaseService } from '../../database/database.service';

export interface ConsentFormRow {
  id: string;
  status: 'draft' | 'published' | 'archived';
  slug: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  /** Phase 3G-1: the client data source this form may map customer-data fields
   *  into. NULL for ordinary SaaS/consent-only forms — unchanged behaviour. */
  source_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CustomerFieldRow {
  id: string;
  form_id: string;
  label: string;
  field_type: string;
  required: boolean;
  destination: 'consent_record' | 'customer_field' | 'both';
  mapped_column: string | null;
  new_column_name: string | null;
  new_column_type: string | null;
  display_order: number;
  status: 'active' | 'removed';
}

export interface FormRow {
  id: string;
  form_id: string;
  consent_purpose_id: string;
  notice_version_id: string;
  label: string;
  notice_text: string;
  inventory_entry_id: string | null;
  inventory_entry_category: string | null;
  active: boolean;
  display_order: number;
  status: 'active' | 'removed';
}

export interface FormSubmissionRow {
  id: string;
  form_id: string;
  subject_ref: string;
  channel: 'widget' | 'link';
  submitted_at: Date;
}

export interface FormSubmissionAnswerRow {
  id: string;
  submission_id: string;
  consent_purpose_id: string;
  consent_purpose_name: string | null;
  granted: boolean;
  consent_event_id: string | null;
}

/**
 * The new-UX consent forms store: a form (`consent_forms`) plus its mutable flat
 * list of consent rows (`consent_form_rows`). See 1737002800000. Nothing here
 * writes consent_events — that stays ConsentService.recordConsent()'s job (R3);
 * this only records the form/rows and the submission bookkeeping.
 */
@Injectable()
export class ConsentFormsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  createForm(input: { name: string; description: string | null; createdBy: string | null }): Promise<ConsentFormRow> {
    return this.db.withTenant(async (client) => {
      // Mint the hosted-link slug at creation so a per-form share link exists as
      // soon as the form has active rows (the slug is an identifier, not a
      // credential — same as the portal slug). status stays 'published' so the
      // hosted-link directory/route treat it as servable; is_active is the live
      // switch that actually gates public visibility.
      const { rows } = await client.query<ConsentFormRow>(
        `INSERT INTO consent_forms (name, description, created_by, status, slug)
         VALUES ($1, $2, $3, 'published', app.mint_form_slug($1, gen_random_uuid()))
         RETURNING *`,
        [input.name, input.description, input.createdBy],
      );
      return rows[0]!;
    });
  }

  getForm(formId: string): Promise<ConsentFormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentFormRow>('SELECT * FROM consent_forms WHERE id = $1', [formId]);
      return rows[0] ?? null;
    });
  }

  updateForm(formId: string, input: { name: string; description: string | null }): Promise<ConsentFormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentFormRow>(
        `UPDATE consent_forms SET name = $2, description = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [formId, input.name, input.description],
      );
      return rows[0] ?? null;
    });
  }

  setFormActive(formId: string, isActive: boolean): Promise<ConsentFormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentFormRow>(
        `UPDATE consent_forms SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [formId, isActive],
      );
      return rows[0] ?? null;
    });
  }

  listForms(): Promise<Array<ConsentFormRow & { row_count: number; active_row_count: number; submission_count: number }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT f.*,
                (SELECT count(*)::int FROM consent_form_rows r WHERE r.form_id = f.id AND r.status = 'active') AS row_count,
                (SELECT count(*)::int FROM consent_form_rows r WHERE r.form_id = f.id AND r.status = 'active' AND r.active) AS active_row_count,
                (SELECT count(*)::int FROM consent_form_submissions s WHERE s.form_id = f.id) AS submission_count
           FROM consent_forms f
          ORDER BY f.updated_at DESC`,
      );
      return rows as Array<ConsentFormRow & { row_count: number; active_row_count: number; submission_count: number }>;
    });
  }

  listRows(formId: string, activeOnly: boolean): Promise<FormRow[]> {
    return this.db.withTenant(async (client) => this.listRowsInClient(client, formId, activeOnly));
  }

  private async listRowsInClient(client: PoolClient, formId: string, activeOnly: boolean): Promise<FormRow[]> {
    const { rows } = await client.query<FormRow>(
      `SELECT r.id, r.form_id, r.consent_purpose_id, r.notice_version_id, r.label, r.notice_text,
              r.inventory_entry_id, r.active, r.display_order, r.status,
              ev.category AS inventory_entry_category
         FROM consent_form_rows r
         LEFT JOIN LATERAL (
           SELECT category FROM inventory_register_entry_versions
            WHERE entry_id = r.inventory_entry_id ORDER BY version_number DESC LIMIT 1
         ) ev ON true
        WHERE r.form_id = $1 AND r.status = 'active'
          ${activeOnly ? 'AND r.active = true' : ''}
        ORDER BY r.display_order, r.label`,
      [formId],
    );
    return rows;
  }

  nextDisplayOrder(formId: string): Promise<number> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM consent_form_rows WHERE form_id = $1 AND status = 'active'`,
        [formId],
      );
      return rows[0]!.next;
    });
  }

  /** Phase 3G-1: associate/clear the form's data source. Config only. */
  setFormSource(formId: string, sourceId: string | null): Promise<ConsentFormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentFormRow>(
        `UPDATE consent_forms SET source_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [formId, sourceId],
      );
      return rows[0] ?? null;
    });
  }

  // --- Phase 3G-1: customer-data field configuration -------------------------

  listCustomerFields(formId: string): Promise<CustomerFieldRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<CustomerFieldRow>(
        `SELECT id, form_id, label, field_type, required, destination, mapped_column,
                new_column_name, new_column_type, display_order, status
           FROM consent_form_customer_fields
          WHERE form_id = $1 AND status = 'active'
          ORDER BY display_order, label`,
        [formId],
      );
      return rows;
    });
  }

  nextCustomerFieldDisplayOrder(formId: string): Promise<number> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM consent_form_customer_fields WHERE form_id = $1 AND status = 'active'`,
        [formId],
      );
      return rows[0]!.next;
    });
  }

  addCustomerField(input: {
    formId: string;
    label: string;
    fieldType: string;
    required: boolean;
    destination: 'consent_record' | 'customer_field' | 'both';
    mappedColumn: string | null;
    newColumnName: string | null;
    newColumnType: string | null;
    displayOrder: number;
  }): Promise<CustomerFieldRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<CustomerFieldRow>(
        `INSERT INTO consent_form_customer_fields
           (form_id, label, field_type, required, destination, mapped_column, new_column_name, new_column_type, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, form_id, label, field_type, required, destination, mapped_column,
                   new_column_name, new_column_type, display_order, status`,
        [
          input.formId,
          input.label,
          input.fieldType,
          input.required,
          input.destination,
          input.mappedColumn,
          input.newColumnName,
          input.newColumnType,
          input.displayOrder,
        ],
      );
      return rows[0]!;
    });
  }

  updateCustomerField(
    fieldId: string,
    input: {
      label: string;
      fieldType: string;
      required: boolean;
      destination: 'consent_record' | 'customer_field' | 'both';
      mappedColumn: string | null;
      newColumnName: string | null;
      newColumnType: string | null;
    },
  ): Promise<CustomerFieldRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<CustomerFieldRow>(
        `UPDATE consent_form_customer_fields
            SET label = $2, field_type = $3, required = $4, destination = $5,
                mapped_column = $6, new_column_name = $7, new_column_type = $8, updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING id, form_id, label, field_type, required, destination, mapped_column,
                    new_column_name, new_column_type, display_order, status`,
        [
          fieldId,
          input.label,
          input.fieldType,
          input.required,
          input.destination,
          input.mappedColumn,
          input.newColumnName,
          input.newColumnType,
        ],
      );
      return rows[0] ?? null;
    });
  }

  /** Soft-removed (I4-consistent) — never a hard delete. */
  removeCustomerField(fieldId: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE consent_form_customer_fields SET status = 'removed', updated_at = now() WHERE id = $1 AND status = 'active'`,
        [fieldId],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  addRow(input: {
    formId: string;
    consentPurposeId: string;
    noticeVersionId: string;
    label: string;
    noticeText: string;
    inventoryEntryId: string | null;
    displayOrder: number;
  }): Promise<FormRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO consent_form_rows
           (form_id, consent_purpose_id, notice_version_id, label, notice_text, inventory_entry_id, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.formId,
          input.consentPurposeId,
          input.noticeVersionId,
          input.label,
          input.noticeText,
          input.inventoryEntryId,
          input.displayOrder,
        ],
      );
      const [row] = await this.oneRow(client, rows[0]!.id);
      return row!;
    });
  }

  updateRow(
    rowId: string,
    input: { label: string; noticeText: string; noticeVersionId: string; inventoryEntryId: string | null },
  ): Promise<FormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE consent_form_rows
            SET label = $2, notice_text = $3, notice_version_id = $4, inventory_entry_id = $5, updated_at = now()
          WHERE id = $1 AND status = 'active'`,
        [rowId, input.label, input.noticeText, input.noticeVersionId, input.inventoryEntryId],
      );
      if (!rowCount) return null;
      const [row] = await this.oneRow(client, rowId);
      return row ?? null;
    });
  }

  setRowActive(rowId: string, active: boolean): Promise<FormRow | null> {
    return this.db.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE consent_form_rows SET active = $2, updated_at = now() WHERE id = $1 AND status = 'active'`,
        [rowId, active],
      );
      if (!rowCount) return null;
      const [row] = await this.oneRow(client, rowId);
      return row ?? null;
    });
  }

  removeRow(rowId: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE consent_form_rows SET status = 'removed', active = false, updated_at = now()
          WHERE id = $1 AND status = 'active'`,
        [rowId],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  private async oneRow(client: PoolClient, rowId: string): Promise<FormRow[]> {
    const { rows } = await client.query<FormRow>(
      `SELECT r.id, r.form_id, r.consent_purpose_id, r.notice_version_id, r.label, r.notice_text,
              r.inventory_entry_id, r.active, r.display_order, r.status,
              ev.category AS inventory_entry_category
         FROM consent_form_rows r
         LEFT JOIN LATERAL (
           SELECT category FROM inventory_register_entry_versions
            WHERE entry_id = r.inventory_entry_id ORDER BY version_number DESC LIMIT 1
         ) ev ON true
        WHERE r.id = $1`,
      [rowId],
    );
    return rows;
  }

  /** Every live form (is_active) with its active rows — the tenant-wide embed's
   *  one read. */
  activeFormsWithRows(): Promise<Array<{ form: ConsentFormRow; rows: FormRow[] }>> {
    return this.db.withTenant(async (client) => {
      const { rows: forms } = await client.query<ConsentFormRow>(
        `SELECT * FROM consent_forms WHERE is_active = true ORDER BY created_at`,
      );
      const out: Array<{ form: ConsentFormRow; rows: FormRow[] }> = [];
      for (const form of forms) {
        const formRows = await this.listRowsInClient(client, form.id, true);
        if (formRows.length > 0) out.push({ form, rows: formRows });
      }
      return out;
    });
  }

  createSubmission(input: {
    formId: string;
    subjectRef: string;
    channel: 'widget' | 'link';
    answers: Array<{ consentPurposeId: string; granted: boolean; consentEventId: string | null; noticeVersionId: string }>;
  }): Promise<FormSubmissionRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<FormSubmissionRow>(
        `INSERT INTO consent_form_submissions (form_id, subject_ref, channel) VALUES ($1, $2, $3) RETURNING *`,
        [input.formId, input.subjectRef, input.channel],
      );
      const submission = rows[0]!;
      for (const a of input.answers) {
        await client.query(
          `INSERT INTO consent_form_submission_answers
             (submission_id, consent_purpose_id, granted, consent_event_id, notice_version_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [submission.id, a.consentPurposeId, a.granted, a.consentEventId, a.noticeVersionId],
        );
      }
      return submission;
    });
  }

  listSubmissions(formId: string): Promise<Array<FormSubmissionRow & { answers: FormSubmissionAnswerRow[] }>> {
    return this.db.withTenant(async (client) => {
      const { rows: submissions } = await client.query<FormSubmissionRow>(
        `SELECT * FROM consent_form_submissions WHERE form_id = $1 ORDER BY submitted_at DESC`,
        [formId],
      );
      if (submissions.length === 0) return [];
      const { rows: answers } = await client.query<FormSubmissionAnswerRow>(
        `SELECT a.id, a.submission_id, a.consent_purpose_id, a.granted, a.consent_event_id,
                cpv.purpose_name AS consent_purpose_name
           FROM consent_form_submission_answers a
           LEFT JOIN LATERAL (
             SELECT purpose_name FROM consent_purpose_versions
              WHERE purpose_id = a.consent_purpose_id ORDER BY version_number DESC LIMIT 1
           ) cpv ON true
          WHERE a.submission_id = ANY($1::uuid[])`,
        [submissions.map((s) => s.id)],
      );
      const byId = new Map<string, FormSubmissionAnswerRow[]>();
      for (const a of answers) {
        const list = byId.get(a.submission_id) ?? [];
        list.push(a);
        byId.set(a.submission_id, list);
      }
      return submissions.map((s) => ({ ...s, answers: byId.get(s.id) ?? [] }));
    });
  }
}
