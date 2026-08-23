import { Injectable, Logger } from '@nestjs/common';
import { StorageRepository, type StorageRootRow } from '../storage/storage.repository';
import { SubmissionDeliveryRepository, type SubmissionDeliveryRow } from './submission-delivery.repository';
import { SubmissionDeliveryCipher } from './submission-delivery-crypto';

/**
 * The submission delivery queue — the cloud relay for a PUBLIC hosted-link
 * consent-form submission's field values/documents, for the case the
 * synchronous write paths (site-wide widget's browser dual-write, the
 * Electron renderer's own dual-write, the Enterprise 'server'-provider
 * synchronous write) cannot cover: a CUSTOMER filling a hosted link on THEIR
 * OWN device, which has no access to the tenant's local/Enterprise storage at
 * all, and the tenant's own machine/agent may be offline right now.
 *
 * ============================================================================
 * DELIBERATE, DOCUMENTED CLAUDE.md I1/R6 EXCEPTION — read before touching this.
 * ============================================================================
 * I1 says the central platform never persists a customer data value; R6 says
 * there is no such thing as temporary durable storage. This table stages
 * exactly that — encrypted, and only for as long as it takes the tenant's own
 * delivery agent to pick it up and confirm the local filesystem write. It
 * exists ONLY because "the browser must never touch a client filesystem path"
 * (correct, unconditional) and "a submission must never be silently lost
 * because the tenant's own machine is offline" (this task's explicit
 * requirement) are jointly unsatisfiable without SOME durable holding point
 * between "customer submits" and "the tenant's machine is next online".
 * Every other write path in the platform is completely unaffected — see
 * ConsentFormsService.submit()'s untouched EnterpriseStorageSyncService call.
 *
 * LIFECYCLE: PENDING -> DELIVERING -> DELIVERED | FAILED (retried while under
 * the attempt cap — see the repository). The payload is decrypted only
 * in-memory, only inside claim() below, only to be handed over the request
 * response the authenticated device is receiving over HTTPS — it is never
 * written to a log, an audit entry, or any other row. It is deleted
 * (columns nulled) the instant ack() runs.
 */
@Injectable()
export class SubmissionDeliveryService {
  private readonly logger = new Logger(SubmissionDeliveryService.name);

  constructor(
    private readonly repo: SubmissionDeliveryRepository,
    private readonly storageRepo: StorageRepository,
    private readonly cipher: SubmissionDeliveryCipher,
  ) {}

  /** Called synchronously from ConsentFormsService.submit() with everything
   *  already resolved (customer identity, display name, field labels) — this
   *  service never re-derives any of that, only stages what it is given.
   *  Never throws: a staging failure must not fail the submission itself. */
  async stage(input: StageDeliveryInput): Promise<void> {
    if (input.fields.length === 0) return; // nothing to relay
    try {
      const plaintext = Buffer.from(JSON.stringify(payloadOf(input)), 'utf8');
      // The delivery id doesn't exist yet at encryption time, so the AAD binds
      // to the submission id instead — still unique per row, still prevents a
      // ciphertext being replayed onto an unrelated delivery record.
      const { ciphertext, iv, authTag } = this.cipher.encrypt(plaintext, input.submissionId);
      await this.repo.create({ submissionId: input.submissionId, formId: input.formId, ciphertext, iv, authTag });
      this.logger.log(`Submission staged for delivery (submission=${input.submissionId}).`);
    } catch (err) {
      this.logger.error(`Could not stage submission for delivery (submission=${input.submissionId}): ${String(err)}`);
    }
  }

  /** Claimable metadata only — no payload. */
  async listPending(): Promise<Array<{ id: string; formId: string; createdAt: string; attemptCount: number }>> {
    const rows = await this.repo.listClaimable(50);
    return rows.map((r) => ({ id: r.id, formId: r.form_id, createdAt: r.created_at.toISOString(), attemptCount: r.attempt_count }));
  }

  /**
   * Atomically claims one delivery, decrypts its payload, and resolves the
   * customer's folder against the tenant's Central DPDP Storage root
   * (provider 'local' — the SAME root Electron/browser central-storage.ts
   * writes into) — the SAME resolve-or-create-with-collision-handling
   * algorithm EnterpriseStorageSyncService.resolveCustomerFolder uses,
   * against the SAME StorageRepository calls, just for a different root
   * (mirrors that established pattern rather than modifying it — see this
   * class's header).
   *
   * Returns `{ ready: false }` (WITHOUT mutating the row) if no Central DPDP
   * Storage root is configured yet — not a delivery failure, just "the
   * tenant hasn't connected a folder yet"; the row stays pending for the next
   * poll rather than burning an attempt on something outside the agent's
   * control.
   */
  async claim(deviceId: string): Promise<ClaimResult> {
    const pending = await this.repo.listClaimable(1);
    const target = pending[0];
    if (!target) return { ready: false, reason: 'NOTHING_PENDING' };

    const root = await this.findCentralLocalRoot();
    if (!root) return { ready: false, reason: 'NOT_CONFIGURED' };

    const claimed = await this.repo.claim(target.id, deviceId);
    if (!claimed) return { ready: false, reason: 'NOTHING_PENDING' }; // lost the race to another claimant

    try {
      const payload = this.decryptPayload(claimed);
      const folder = await this.resolveCustomerFolder(root, payload.customerId, payload.displayName?.trim() || `customer-${payload.customerId.slice(0, 8)}`);
      return {
        ready: true,
        deliveryId: claimed.id,
        folderName: folder.name,
        customerId: payload.customerId,
        subjectRef: payload.subjectRef,
        displayName: payload.displayName,
        templateName: payload.templateName,
        retentionMonths: payload.retentionMonths,
        fields: payload.fields,
      };
    } catch (err) {
      // Decryption/resolution failed with the row already claimed — return it
      // to pending immediately rather than leaving it stuck as 'delivering'
      // for the full stale-claim window.
      await this.repo.markFailed(claimed.id, err instanceof Error ? err.message : 'Could not prepare this delivery.');
      throw err;
    }
  }

  async ack(deliveryId: string, deviceId: string): Promise<boolean> {
    const claimed = await this.repo.findClaimedByDevice(deliveryId, deviceId);
    if (!claimed) return false;
    const updated = await this.repo.markDelivered(deliveryId);
    if (updated) this.logger.log(`Submission delivered (delivery=${deliveryId}).`);
    return !!updated;
  }

  async fail(deliveryId: string, deviceId: string, error: string): Promise<boolean> {
    const claimed = await this.repo.findClaimedByDevice(deliveryId, deviceId);
    if (!claimed) return false;
    const updated = await this.repo.markFailed(deliveryId, error);
    if (updated) this.logger.warn(`Submission delivery failed (delivery=${deliveryId} status=${updated.status}): ${error}`);
    return !!updated;
  }

  // --- customer-folder resolution (mirrors EnterpriseStorageSyncService, provider='local') ---

  private async findCentralLocalRoot(): Promise<StorageRootRow | null> {
    const roots = await this.storageRepo.listRoots(false);
    return roots.find((r) => r.name === CENTRAL_STORAGE_ROOT_NAME && r.provider === 'local') ?? null;
  }

  private async resolveCustomerFolder(root: StorageRootRow, customerId: string, displayNameHint: string): Promise<{ folderId: string; name: string }> {
    const existing = await this.storageRepo.findMapping('data_principal', customerId);
    if (existing && existing.status === 'active') {
      const folder = await this.storageRepo.findFolder(existing.folder_id);
      if (folder && folder.status === 'active') return { folderId: folder.id, name: folder.name };
    }

    const allFolders = await this.storageRepo.listAllFoldersForRoot(root.id);
    const customersFolder = allFolders.find((f) => f.parent_folder_id === null && f.name === CUSTOMERS_FOLDER_NAME);
    if (!customersFolder) {
      throw new Error(`The "${CUSTOMERS_FOLDER_NAME}" folder is missing on storage root ${root.id}.`);
    }
    const siblingNames = new Set(allFolders.filter((f) => f.parent_folder_id === customersFolder.id).map((f) => f.name));

    const baseName = sanitizeLabel(displayNameHint);
    const name = siblingNames.has(baseName) ? `${baseName} (${customerId.slice(0, 6)})` : baseName;

    const folder = await this.storageRepo.createFolder({ storageRootId: root.id, parentFolderId: customersFolder.id, name, createdBy: null });
    await this.storageRepo.upsertMapping({ moduleKey: 'data_principal', entityId: customerId, folderId: folder.id, createdBy: null });
    return { folderId: folder.id, name: folder.name };
  }

  private decryptPayload(row: SubmissionDeliveryRow): StagedPayloadJson {
    if (!row.payload_ciphertext || !row.payload_iv || !row.payload_auth_tag) {
      throw new Error('This delivery has no staged payload.');
    }
    const plaintext = this.cipher.decrypt(row.payload_ciphertext, row.payload_iv, row.payload_auth_tag, row.submission_id);
    return JSON.parse(plaintext.toString('utf8')) as StagedPayloadJson;
  }
}

// --- shared constants (mirrors central-storage.ts / server-storage-fs.ts — see this file's header) ---

const CENTRAL_STORAGE_ROOT_NAME = 'DPDP Central Storage';
const CUSTOMERS_FOLDER_NAME = 'Customers';

function sanitizeLabel(raw: string): string {
  const cleaned = raw.trim().replace(/[\\/:*?"<>|-]/g, '_').slice(0, 120);
  return cleaned || 'unnamed';
}

// --- types -------------------------------------------------------------------

export interface StageDeliveryFieldInput {
  label: string;
  textValue?: string;
  file?: { filename: string; contentBase64: string };
}

export interface StageDeliveryInput {
  submissionId: string;
  formId: string;
  customerId: string;
  subjectRef: string;
  displayName: string | null;
  templateName: string;
  retentionMonths: number | null;
  fields: StageDeliveryFieldInput[];
}

interface StagedPayloadJson {
  customerId: string;
  subjectRef: string;
  displayName: string | null;
  templateName: string;
  retentionMonths: number | null;
  fields: StageDeliveryFieldInput[];
}

function payloadOf(input: StageDeliveryInput): StagedPayloadJson {
  return {
    customerId: input.customerId,
    subjectRef: input.subjectRef,
    displayName: input.displayName,
    templateName: input.templateName,
    retentionMonths: input.retentionMonths,
    fields: input.fields,
  };
}

export type ClaimResult =
  | { ready: false; reason: 'NOTHING_PENDING' | 'NOT_CONFIGURED' }
  | {
      ready: true;
      deliveryId: string;
      folderName: string;
      customerId: string;
      subjectRef: string;
      displayName: string | null;
      templateName: string;
      retentionMonths: number | null;
      fields: StageDeliveryFieldInput[];
    };
