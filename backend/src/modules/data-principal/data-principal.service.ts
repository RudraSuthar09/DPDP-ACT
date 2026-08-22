import { Injectable } from '@nestjs/common';
import { DataPrincipalRepository } from './data-principal.repository';

/**
 * The customer/data-principal identity registry — resolves the existing
 * EXTERNAL, deterministic `subject_ref` (SubjectRefHasher, I2 — unchanged,
 * still computed the same way, still irreversible by the platform) to a
 * stable INTERNAL customer UUID. That UUID, never subject_ref itself, is
 * what `storage_mappings.entity_id` (moduleKey 'data_principal') actually
 * uses — subject_ref is a 64-character hex digest, not a UUID, and never
 * belongs in a uuid column.
 *
 * Deliberately generic, not consent-specific: any future module (Grievance,
 * DSR, Breach, Data Inventory) that already has a subject_ref for the same
 * customer resolves through this SAME service to the SAME customer_id —
 * never a second, competing identity mechanism per module (R2).
 */
@Injectable()
export class DataPrincipalService {
  constructor(private readonly repo: DataPrincipalRepository) {}

  /** Resolve subjectRef to its stable internal customer_id, creating the
   *  registry row on first sight. The SAME subjectRef always yields the
   *  SAME customer_id — this is what makes "the same customer submitting
   *  twice reuses one folder" possible. */
  async resolveCustomerId(subjectRef: string): Promise<string> {
    const row = await this.repo.resolveOrCreate(subjectRef);
    return row.id;
  }
}
