import { Injectable, Logger } from '@nestjs/common';
import { StorageRepository, type StorageRootRow } from '../storage/storage.repository';
import { SubmissionDeliveryRepository, type SubmissionDeliveryRow, type SubmissionDeliveryStatus } from './submission-delivery.repository';
import { SubmissionDeliveryCipher } from './submission-delivery-crypto';
import type { DeliveryClaimInput } from './submission-delivery.dto';

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

  /**
   * Enterprise COPIES of mapped fields (decision: additional to Central,
   * which stage() above handles exactly as before). For each submitted field
   * whose existing Additional Storage mapping (moduleKey
   * 'consent_form_field') points at an ACTIVE folder under an ACTIVE
   * Gateway-provider storage root, the value is staged — encrypted, in the
   * existing queue — as one row per destination root. Fields mapped to a
   * browser-local folder, or not mapped, are untouched (the browser handles
   * local Additional Storage exactly as before).
   *
   * The destination comes ONLY from the tenant's own mapping rows, resolved
   * here under RLS — never from anything the submitting browser sends. The
   * filename is fixed per submission + field (see enterpriseCopyFilename),
   * so a new submission never targets an earlier one's file and a retry
   * always targets the same one.
   *
   * Never throws: like stage(), a staging failure must not fail the
   * submission (the consent is already recorded). It is logged; the
   * Submissions view then simply shows no Enterprise copy for it.
   */
  async stageEnterpriseCopies(input: StageEnterpriseCopiesInput): Promise<number> {
    const byRoot = new Map<string, EnterpriseCopyFileJson[]>();
    try {
      for (const field of input.fields) {
        const mapping = await this.storageRepo.findMapping('consent_form_field', field.fieldId);
        if (!mapping || mapping.status !== 'active') continue;
        const folder = await this.storageRepo.findFolder(mapping.folder_id);
        if (!folder || folder.status !== 'active') continue;
        const root = await this.storageRepo.findRoot(folder.storage_root_id);
        if (!root || root.status !== 'active' || root.provider !== 'gateway') continue;
        const contentBase64 = field.file ? field.file.contentBase64 : Buffer.from(field.textValue ?? '', 'utf8').toString('base64');
        if (!field.file && !(field.textValue ?? '').trim()) continue;
        const files = byRoot.get(root.id) ?? [];
        files.push({
          folderId: folder.id,
          filename: enterpriseCopyFilename({
            submissionId: input.submissionId,
            fieldId: field.fieldId,
            label: field.label,
            originalFilename: field.file?.filename ?? null,
            extension: field.file?.extension ?? null,
          }),
          contentBase64,
        });
        byRoot.set(root.id, files);
      }
      for (const [rootId, files] of byRoot) {
        const plaintext = Buffer.from(JSON.stringify({ files } satisfies EnterpriseCopyPayloadJson), 'utf8');
        const { ciphertext, iv, authTag } = this.cipher.encrypt(plaintext, enterpriseCopyAad(input.submissionId, rootId));
        await this.repo.create({ submissionId: input.submissionId, formId: input.formId, ciphertext, iv, authTag, targetStorageRootId: rootId });
      }
      if (byRoot.size > 0) this.logger.log(`Enterprise copies staged (submission=${input.submissionId}, destinations=${byRoot.size}).`);
      return byRoot.size;
    } catch (err) {
      this.logger.error(`Could not stage Enterprise copies (submission=${input.submissionId}): ${err instanceof Error ? err.name : 'error'}`);
      return 0;
    }
  }

  /** Does the tenant have a Central DPDP Storage location at all — the
   *  browser/Electron/agent Central root, or an Enterprise 'server' root?
   *  Read-only; lets the Submissions view stop waiting on a destination
   *  that does not exist. */
  async hasCentralDestination(): Promise<boolean> {
    const roots = await this.storageRepo.listRoots(false);
    return roots.some((r) => r.status === 'active' && ((r.provider === 'local' && r.name === CENTRAL_STORAGE_ROOT_NAME) || r.provider === 'server'));
  }

  /** Newest delivery state per submission, one entry per destination
   *  (Central = target null, or each Enterprise storage root). Metadata only —
   *  no payload, no error text. A submission with no rows is absent. */
  async latestStatuses(
    submissionIds: string[],
  ): Promise<Map<string, Array<{ target: string | null; status: SubmissionDeliveryStatus; attemptCount: number }>>> {
    const rows = await this.repo.latestStatusForSubmissions(submissionIds);
    const out = new Map<string, Array<{ target: string | null; status: SubmissionDeliveryStatus; attemptCount: number }>>();
    for (const r of rows) {
      const list = out.get(r.submission_id) ?? [];
      list.push({ target: r.target_storage_root_id, status: r.status, attemptCount: r.attempt_count });
      out.set(r.submission_id, list);
    }
    return out;
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
  async claim(deviceId: string, can: DeliveryClaimInput = { central: true, storageRootIds: [] }): Promise<ClaimResult> {
    // A Central row is only offered when a Central root exists — otherwise it
    // would sit at the head of the queue and block Enterprise copies behind it.
    const root = can.central ? await this.findCentralLocalRoot() : null;
    const pending = await this.repo.listClaimableFor(1, { central: root !== null, storageRootIds: can.storageRootIds });
    const target = pending[0];
    if (!target) {
      // Same answer as before for an agent that can only do Central work and
      // the tenant has none configured: "waiting", not "nothing to do".
      if (can.central && !root && (await this.repo.listClaimableFor(1, { central: true, storageRootIds: [] })).length > 0) {
        return { ready: false, reason: 'NOT_CONFIGURED' };
      }
      return { ready: false, reason: 'NOTHING_PENDING' };
    }

    const claimed = await this.repo.claim(target.id, deviceId);
    if (!claimed) return { ready: false, reason: 'NOTHING_PENDING' }; // lost the race to another claimant

    if (claimed.target_storage_root_id) return this.prepareEnterpriseCopy(claimed, deviceId);
    // Unreachable (a Central row is only offered when the root exists) —
    // checked anyway so a Central payload can never be handed out without one.
    if (!root) {
      await this.repo.markFailed(claimed.id, 'NOT_CONFIGURED');
      return { ready: false, reason: 'NOT_CONFIGURED' };
    }

    try {
      const payload = this.decryptPayload(claimed);
      const folder = await this.resolveCustomerFolder(root, payload.customerId, payload.displayName?.trim() || `customer-${payload.customerId.slice(0, 8)}`);
      return {
        ready: true,
        target: 'central',
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

  /**
   * Hands a claimed Enterprise copy to the device, re-checking authorization
   * NOW (not trusting what was true at submission time):
   *   - the target root still exists, is active, is Gateway-provider, and is
   *     bound to THIS device (the agent separately refuses any root its own
   *     administrator has not authorized for writing);
   *   - every target folder is still active under that same root.
   * Folder ids become folder NAMES walked up from the root — never an OS
   * path. Any failure puts the row back for a retry (markFailed, which stops
   * retrying after MAX_ATTEMPTS) with a fixed, path-free reason.
   */
  private async prepareEnterpriseCopy(claimed: SubmissionDeliveryRow, deviceId: string): Promise<ClaimResult> {
    const rootId = claimed.target_storage_root_id!;
    const refuse = async (reason: string): Promise<ClaimResult> => {
      await this.repo.markFailed(claimed.id, reason);
      return { ready: false, reason: 'NOTHING_PENDING' };
    };
    const root = await this.storageRepo.findRoot(rootId);
    if (!root || root.status !== 'active' || root.provider !== 'gateway' || root.gateway_device_id !== deviceId) {
      return refuse('DESTINATION_NOT_AVAILABLE');
    }
    let payload: EnterpriseCopyPayloadJson;
    try {
      payload = this.decryptPayload(claimed, enterpriseCopyAad(claimed.submission_id, rootId)) as unknown as EnterpriseCopyPayloadJson;
    } catch {
      return refuse('PAYLOAD_UNREADABLE');
    }
    const folders = new Map((await this.storageRepo.listAllFoldersForRoot(root.id)).map((f) => [f.id, f]));
    const files: Array<{ path: string[]; filename: string; contentBase64: string }> = [];
    for (const f of payload.files) {
      const path = folderPath(folders, f.folderId);
      if (!path) return refuse('DESTINATION_FOLDER_REMOVED');
      files.push({ path, filename: f.filename, contentBase64: f.contentBase64 });
    }
    return { ready: true, target: 'gateway', deliveryId: claimed.id, storageRootId: rootId, files };
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

  /** `aad` defaults to the submission id — the Central row's binding, which
   *  is unchanged; an Enterprise copy binds to submission + root instead, so
   *  one row's ciphertext can never be replayed into another destination. */
  private decryptPayload(row: SubmissionDeliveryRow, aad: string = row.submission_id): StagedPayloadJson {
    if (!row.payload_ciphertext || !row.payload_iv || !row.payload_auth_tag) {
      throw new Error('This delivery has no staged payload.');
    }
    const plaintext = this.cipher.decrypt(row.payload_ciphertext, row.payload_iv, row.payload_auth_tag, aad);
    return JSON.parse(plaintext.toString('utf8')) as StagedPayloadJson;
  }
}

// --- Enterprise copies -------------------------------------------------------

export function enterpriseCopyAad(submissionId: string, storageRootId: string): string {
  return `${submissionId}:enterprise:${storageRootId}`;
}

/**
 * The file name of one field's Enterprise copy: unique per submission AND
 * field (labels are not unique within a form), and identical on every retry
 * of the same delivery — which is what lets the agent treat "already exists"
 * as "a previous attempt of this delivery completed" without ever
 * overwriting. Human-readable label first, same sanitizing rule as every
 * existing writer (sanitizeLabel). A document keeps only its original
 * extension (a long original name could otherwise push the name past the
 * Gateway's length limit); an unusual extension is dropped rather than
 * guessed. Text values are .txt, like the existing value.txt convention.
 */
export function enterpriseCopyFilename(input: {
  submissionId: string;
  fieldId: string;
  label: string;
  originalFilename: string | null;
  /** The extension PROVED from the file's own bytes (consent-uploads.ts:
   *  inspectUpload). When present it wins outright, and originalFilename is
   *  not consulted at all — a respondent chooses neither what their file is
   *  called on the client's disk nor what it claims to be. Absent only for
   *  the legacy upload types, which still fall back to the sanitized
   *  extension below. */
  extension?: string | null;
}): string {
  const base = `${sanitizeLabel(input.label).slice(0, 60)} - ${input.submissionId} - ${input.fieldId}`;
  if (input.extension && /^\.[a-z0-9]{1,10}$/.test(input.extension)) return `${base}${input.extension}`;
  if (input.originalFilename === null) return `${base}.txt`;
  const dot = input.originalFilename.lastIndexOf('.');
  const ext = dot > 0 ? input.originalFilename.slice(dot).toLowerCase() : '';
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? `${base}${ext}` : base;
}

/** Folder NAMES from the root down to `folderId`, or null if the folder (or
 *  any ancestor) is no longer an active folder of this root. */
function folderPath(folders: Map<string, { id: string; name: string; parent_folder_id: string | null }>, folderId: string): string[] | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = folders.get(folderId);
  while (current) {
    if (seen.has(current.id)) return null; // defensive: never loop on a corrupt tree
    seen.add(current.id);
    names.unshift(current.name);
    if (current.parent_folder_id === null) return names;
    current = folders.get(current.parent_folder_id);
  }
  return null;
}

// --- shared constants (mirrors central-storage.ts / server-storage-fs.ts — see this file's header) ---

const CENTRAL_STORAGE_ROOT_NAME = 'DPDP Central Storage';
const CUSTOMERS_FOLDER_NAME = 'Customers';

function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|-]/g, '_')
    // Dots too. No separator survives the line above, so directory traversal
    // was already impossible; but a label of "../.." still left a leading
    // ".." in the stored filename — a name no client should be handed, and
    // one some tools treat specially. Each run of dots becomes one
    // underscore. This also affects an ordinary label like "Photo v1.2",
    // which now stores as "Photo v1_2": a cosmetic change to a filename,
    // and the safer default.
    .replace(/\.+/g, '_')
    .slice(0, 120);
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

export interface StageEnterpriseCopiesInput {
  submissionId: string;
  formId: string;
  fields: Array<{
    fieldId: string;
    label: string;
    textValue?: string;
    /** `extension` is the one PROVED from the bytes; it decides the stored
     *  filename (see enterpriseCopyFilename). */
    file?: { filename: string; contentBase64: string; extension?: string | null };
  }>;
}

interface EnterpriseCopyFileJson {
  folderId: string;
  filename: string;
  contentBase64: string;
}
interface EnterpriseCopyPayloadJson {
  files: EnterpriseCopyFileJson[];
}

export type ClaimResult =
  | { ready: false; reason: 'NOTHING_PENDING' | 'NOT_CONFIGURED' }
  | {
      ready: true;
      target: 'gateway';
      deliveryId: string;
      storageRootId: string;
      files: Array<{ path: string[]; filename: string; contentBase64: string }>;
    }
  | {
      ready: true;
      target: 'central';
      deliveryId: string;
      folderName: string;
      customerId: string;
      subjectRef: string;
      displayName: string | null;
      templateName: string;
      retentionMonths: number | null;
      fields: StageDeliveryFieldInput[];
    };
