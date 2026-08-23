import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ANONYMOUS_TENANT_USER_ID, type TenantContext } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { TenantDatabaseService } from '../../database/database.service';
import { SystemAuditService } from '../audit/system-audit.service';
import { StorageRepository, type StorageRootRow } from '../storage/storage.repository';
import { ConsentFormsRepository } from '../consent/consent-forms.repository';
import { DataPrincipalService } from '../data-principal/data-principal.service';
import {
  CONSENT_REGISTER_FOLDER_NAME,
  CUSTOMERS_FOLDER_NAME,
  CUSTOMER_INFORMATION_FOLDER_NAME,
  ensureDir,
  ensureTopLevelFoldersOnDisk,
  sanitizeLabel,
  verifyServerPathWritable,
  writeJsonFile,
  writeRawFile,
  writeTextFile,
} from './server-storage-fs';

export interface FieldValueToWrite {
  label: string;
  textValue?: string;
  file?: { filename: string; bytes: Buffer };
}

export interface WriteSubmissionFieldsInput {
  customerId: string;
  subjectRef: string;
  displayNameHint: string;
  templateName: string;
  retentionMonths: number | null;
  fields: FieldValueToWrite[];
}

/**
 * The Enterprise half of Central DPDP Storage automatic sync — see the
 * inspection note (delivered before implementation) for the full "why".
 *
 * Two entry points, two very different data-availability stories:
 *
 *   - writeSubmissionFieldsNow: called SYNCHRONOUSLY from ConsentFormsService.
 *     submit(), in the API process, while the submission's actual field
 *     values (Aadhaar/PDF, Excel, text) still exist in memory. This is the
 *     ONLY moment those values are ever available server-side — CLAUDE.md's
 *     R6 forbids durably queuing raw customer values anywhere (a temp table,
 *     cache, FILE, or LOG — including a pg-boss job payload, which durably
 *     lives in Postgres), so there is no way to defer this write and retry
 *     it later with the real bytes. If the configured path is unreachable
 *     right now, the values are gone; the consent GRANT itself is never
 *     lost (ConsentService.recordConsent already committed), only the
 *     files could not be filed this time.
 *
 *   - syncTenant: called PERIODICALLY from the worker's ticker (see
 *     enterprise-storage-sync.worker.ts), with NO field values available at
 *     all (worker process, no HTTP request, no in-memory upload). It can
 *     only recover Customer Information (profile.json/retention.json) for
 *     submissions still pending — the exact same honest limitation the
 *     browser's deferred sync already has for SaaS (central-storage.ts /
 *     storage/page.tsx's onSyncPending: "field values collected on a device
 *     with no connected storage are simply not recoverable, by design").
 *     This is what makes Enterprise resilient to "the path was down when a
 *     submission came in, or the worker itself was down" for everything
 *     except the field bytes specifically.
 */
@Injectable()
export class EnterpriseStorageSyncService {
  private readonly logger = new Logger(EnterpriseStorageSyncService.name);

  constructor(
    private readonly storageRepo: StorageRepository,
    private readonly consentForms: ConsentFormsRepository,
    private readonly dataPrincipals: DataPrincipalService,
    private readonly tenantContext: TenantContextService,
    private readonly db: TenantDatabaseService,
    private readonly systemAudit: SystemAuditService,
  ) {}

  /** Whether THIS tenant currently has an active 'server' storage root —
   *  used by ConsentFormsService.publicFormForLink() so the hosted-link
   *  frontend knows whether to include field values on submit at all (never
   *  sent for a tenant with no Enterprise server storage configured). Runs
   *  under the ambient (HTTP request) tenant context. */
  async hasActiveServerRoot(): Promise<boolean> {
    return (await this.findActiveServerRoot()) !== null;
  }

  /** The synchronous, submission-time write. Runs under the ambient (HTTP
   *  request) tenant context — called only from ConsentFormsService.submit().
   *  Never throws: a failure here must never fail the consent submission
   *  itself. The caller marks local_synced_at only when this returns
   *  `success: true`. */
  async writeSubmissionFieldsNow(
    input: WriteSubmissionFieldsInput,
  ): Promise<{ attempted: boolean; success: boolean }> {
    // Ids/path/customer only — never a field VALUE (I1) — but everything
    // needed to diagnose "the folder is writable but nothing appeared"
    // without re-deriving it from scratch. Included on every log line below.
    const tenantId = this.tenantContext.get()?.tenantId ?? 'unknown';
    const logCtx = () => `tenant=${tenantId} customerId=${input.customerId} displayName="${input.displayNameHint}"`;

    let root: StorageRootRow | null;
    try {
      root = await this.findActiveServerRoot();
    } catch (err) {
      this.logger.error(`Could not look up the Enterprise storage root (${logCtx()}): ${String(err)}`);
      return { attempted: false, success: false };
    }
    if (!root || !root.root_path) {
      this.logger.debug(`No active 'server' storage root configured (${logCtx()}) — nothing to write.`);
      return { attempted: false, success: false };
    }

    // root_path is a non-secret reference (see the migration/storage.dto
    // header) — safe to log plainly, same discipline as the rest of the
    // storage module.
    const rootCtx = () => `${logCtx()} storageRootId=${root!.id} rootPath="${root!.root_path}"`;

    try {
      const reachable = await verifyServerPathWritable(root.root_path);
      if (!reachable) {
        this.logger.warn(`Enterprise storage path unreachable at submission time — files not written (${rootCtx()}).`);
        return { attempted: true, success: false };
      }

      await ensureTopLevelFoldersOnDisk(root.root_path);
      await this.ensureTopLevelFolderRows(root);

      const folder = await this.resolveCustomerFolder(root, input.customerId, input.displayNameHint);
      this.logger.log(`Enterprise sync: writing submission (${rootCtx()} folder="${folder.name}").`);

      await writeJsonFile(
        root.root_path,
        [CUSTOMERS_FOLDER_NAME, folder.name, CUSTOMER_INFORMATION_FOLDER_NAME],
        'profile.json',
        { customerId: input.customerId, subjectRef: input.subjectRef, displayName: input.displayNameHint, createdAt: new Date().toISOString() },
      );
      if (input.retentionMonths !== null) {
        await writeJsonFile(
          root.root_path,
          [CUSTOMERS_FOLDER_NAME, folder.name, CUSTOMER_INFORMATION_FOLDER_NAME],
          'retention.json',
          { templateName: input.templateName, retentionMonths: input.retentionMonths },
        );
      }

      for (const field of input.fields) {
        const segments = [CUSTOMERS_FOLDER_NAME, folder.name, CONSENT_REGISTER_FOLDER_NAME, sanitizeLabel(input.templateName), sanitizeLabel(field.label)];
        try {
          if (field.file) {
            await writeRawFile(root.root_path, segments, field.file.filename || 'value', field.file.bytes);
          } else if (field.textValue !== undefined && field.textValue.trim().length > 0) {
            await writeTextFile(root.root_path, segments, 'value.txt', field.textValue);
          }
        } catch (err) {
          this.logger.error(`Enterprise storage field write failed (${rootCtx()} field="${field.label}" targetPath="${segments.join('/')}"): ${String(err)}`);
          throw err;
        }
      }

      this.logger.log(`Enterprise sync: submission written successfully (${rootCtx()} folder="${folder.name}").`);
      return { attempted: true, success: true };
    } catch (err) {
      this.logger.error(`Enterprise storage write failed (${rootCtx()}): ${String(err)}`);
      return { attempted: true, success: false };
    }
  }

  /** Which tenants currently have an active 'server' root — the worker
   *  ticker's outer loop. Cross-tenant by necessity (see the migration's
   *  app.storage_server_roots_active peephole), ids + a non-secret path only. */
  async listTenantsWithServerStorage(): Promise<string[]> {
    return this.db.runUntenanted(async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM app.storage_server_roots_active()');
      return [...new Set(rows.map((r) => r.tenant_id))];
    });
  }

  /** The worker's periodic catch-up sweep for one tenant — Customer
   *  Information + folder only (see the class doc for why field values
   *  cannot be recovered here). Binds a synthetic tenant context (no real
   *  HTTP request behind this — the worker process, running 24/7). */
  async syncTenant(tenantId: string): Promise<{ synced: number; failed: number }> {
    return this.tenantContext.run(syntheticWorkerContext(tenantId), () => this.syncTenantWithinContext(tenantId));
  }

  private async syncTenantWithinContext(tenantId: string): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    const root = await this.findActiveServerRoot();
    if (!root || !root.root_path) return { synced, failed };
    const rootCtx = () => `tenant=${tenantId} storageRootId=${root.id} rootPath="${root.root_path}"`;

    const reachable = await verifyServerPathWritable(root.root_path);
    if (!reachable) {
      this.logger.warn(`Enterprise storage path unreachable during sweep (${rootCtx()}) — will retry next tick.`);
      return { synced, failed };
    }

    await ensureTopLevelFoldersOnDisk(root.root_path);
    await this.ensureTopLevelFolderRows(root);

    const formIds = await this.consentForms.listActiveFormIds();
    for (const formId of formIds) {
      const pending = await this.consentForms.listPendingLocalSync(formId);
      for (const submission of pending) {
        try {
          // Read-only resolution (no name argument) — the worker sweep never
          // learns a NEW name (it has no submitted field values at all, see
          // this class's header); it uses whatever name a synchronous
          // submission may have already recorded on data_principals.
          const { customerId, displayName } = await this.dataPrincipals.resolve(submission.subject_ref);
          const displayNameHint = displayName?.trim() || `customer-${customerId.slice(0, 8)}`;
          const folder = await this.resolveCustomerFolder(root, customerId, displayNameHint);

          await writeJsonFile(
            root.root_path,
            [CUSTOMERS_FOLDER_NAME, folder.name, CUSTOMER_INFORMATION_FOLDER_NAME],
            'profile.json',
            { customerId, subjectRef: submission.subject_ref, displayName, createdAt: submission.submitted_at.toISOString() },
          );

          // Atomic mark-synced + audit entry, on the same client (the S5
          // hash chain, the worker-side pattern — see SystemAuditService).
          await this.db.withTenantIdDetached(tenantId, async (client) => {
            await this.consentForms.markSubmissionSyncedOnClient(client, formId, submission.id);
            await this.systemAudit.record(client, tenantId, {
              action: 'consent.form.submission_local_synced',
              outcome: 'success',
              correlationId: randomUUID(),
              actorLabel: 'system:enterprise-storage-sync',
              targetType: 'consent_form_submission',
              targetId: submission.id,
              reason: 'Consent submission written into Enterprise Central DPDP Storage (Customer Information only — field values were not available to the worker; see the deferred-sync limitation).',
              afterState: { locallySynced: true, recoveredBy: 'worker-sweep' },
            });
          });
          synced += 1;
        } catch (err) {
          failed += 1;
          this.logger.error(`Enterprise sweep failed (${rootCtx()} submissionId=${submission.id}): ${String(err)}`);
        }
      }
    }

    return { synced, failed };
  }

  // --- shared helpers ---------------------------------------------------

  private async findActiveServerRoot(): Promise<StorageRootRow | null> {
    const roots = await this.storageRepo.listRoots(false);
    return roots.find((r) => r.provider === 'server') ?? null;
  }

  /** Idempotent: creates the five top-level storage_folders rows this root
   *  doesn't already have. Mirrors central-storage.ts's ensureTopLevelFolders
   *  exactly, just against a 'server' root's real directories instead of a
   *  browser handle. */
  private async ensureTopLevelFolderRows(root: StorageRootRow): Promise<void> {
    const existing = await this.storageRepo.listAllFoldersForRoot(root.id);
    const existingTopLevel = new Set(existing.filter((f) => f.parent_folder_id === null).map((f) => f.name));
    const seedNames = ['Customers', 'Data Inventory', 'Grievances', 'DSR', 'Breach'];
    for (const name of seedNames) {
      if (!existingTopLevel.has(name)) {
        await this.storageRepo.createFolder({ storageRootId: root.id, parentFolderId: null, name, createdBy: null });
      }
    }
  }

  /** Resolve-or-create a customer's own folder, mirroring central-storage.ts's
   *  resolveCustomerFolder exactly (same storage_mappings moduleKey
   *  'data_principal', same collision-disambiguation rule) — just realized
   *  with Node fs instead of the browser's directory handle. */
  private async resolveCustomerFolder(
    root: StorageRootRow,
    customerId: string,
    displayNameHint: string,
  ): Promise<{ folderId: string; name: string }> {
    const existing = await this.storageRepo.findMapping('data_principal', customerId);
    if (existing && existing.status === 'active') {
      const folder = await this.storageRepo.findFolder(existing.folder_id);
      if (folder && folder.status === 'active') {
        await ensureDirOnDisk(root.root_path!, folder.name);
        return { folderId: folder.id, name: folder.name };
      }
    }

    const allFolders = await this.storageRepo.listAllFoldersForRoot(root.id);
    const customersFolder = allFolders.find((f) => f.parent_folder_id === null && f.name === CUSTOMERS_FOLDER_NAME);
    if (!customersFolder) {
      throw new Error(`The "${CUSTOMERS_FOLDER_NAME}" folder is missing on storage root ${root.id}.`);
    }
    const siblingNames = new Set(allFolders.filter((f) => f.parent_folder_id === customersFolder.id).map((f) => f.name));

    const baseName = sanitizeLabel(displayNameHint);
    const name = siblingNames.has(baseName) ? `${baseName} (${customerId.slice(0, 6)})` : baseName;

    await ensureDirOnDisk(root.root_path!, name);
    const folder = await this.storageRepo.createFolder({
      storageRootId: root.id,
      parentFolderId: customersFolder.id,
      name,
      createdBy: null,
    });
    await this.storageRepo.upsertMapping({ moduleKey: 'data_principal', entityId: customerId, folderId: folder.id, createdBy: null });
    return { folderId: folder.id, name: folder.name };
  }
}

async function ensureDirOnDisk(rootPath: string, customerFolderName: string): Promise<void> {
  await ensureDir(rootPath, [CUSTOMERS_FOLDER_NAME, customerFolderName]);
}

/** No real user/request behind a worker sweep tick — the same pattern
 *  documented for TenantContext.isAnonymous (public request portal), reused
 *  here for the same reason: a real actor genuinely does not exist. Nothing
 *  in the write path this context is used for (StorageRepository/
 *  ConsentFormsRepository/DataPrincipalService reads + the two createdBy:
 *  null writes above) attributes a change to this userId. */
function syntheticWorkerContext(tenantId: string): TenantContext {
  return {
    tenantId,
    userId: ANONYMOUS_TENANT_USER_ID,
    role: 'owner',
    correlationId: randomUUID(),
    anonymous: true,
  };
}
