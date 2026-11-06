/**
 * The submission delivery poller — the client half of the cloud relay queue
 * (backend/src/modules/delivery). Runs entirely independently of Electron:
 * this process is what stays delivering while "Electron may be completely
 * closed" (an explicit product requirement).
 *
 * Loop, every pollIntervalSeconds: resolve the local storage root (from
 * Electron's own config file, or the configured fallback) -> claim ONE
 * pending submission (atomic, decrypted only in-memory) -> write it via
 * local-fs-ops (the SAME Customer Information / Consent Register structure
 * every other runtime already produces) -> ack on success, fail (with a
 * SANITIZED reason only — never a field value) on any write error, so it is
 * retried automatically rather than lost.
 *
 * [Submission]/[Agent]/[Storage] log lines are structured but NEVER include a
 * field value or document content — ids, folder NAMES, and outcome only,
 * matching this file's own log() calls below.
 */
import type { ClaimedCentralSubmission, ClaimedGatewayCopy, GatewayControlPlaneClient } from '../enrollment';
import { StorageNotConfiguredError, type StorageRegistry } from '../storage/registry';
import { loadLocalRootConfig, resolveLocalStorageRoot, type LocalRootConfig } from './local-root';
import { sanitizeLabel, writeJsonFile, writeRawFile, writeTextFile } from './local-fs-ops';

const CUSTOMERS_FOLDER_NAME = 'Customers';
const CUSTOMER_INFORMATION_FOLDER_NAME = 'Customer Information';
const CONSENT_REGISTER_FOLDER_NAME = 'Consent Register';

/** Per poll tick, drain up to this many claims before waiting for the next
 *  tick — so a backlog (submissions collected while this agent was offline)
 *  clears quickly instead of one-per-interval. */
const MAX_CLAIMS_PER_TICK = 10;

export interface DeliveryPollerOptions {
  client: GatewayControlPlaneClient;
  deviceToken: string;
  pollIntervalSeconds: number;
  localRootConfig?: LocalRootConfig;
  /** The storage plane's registry: ONLY the storage locations the Gateway
   *  administrator explicitly authorized for writing. Absent = none. */
  storageRegistry?: StorageRegistry;
  log: (line: string) => void;
}

/**
 * Starts the poller; returns a stop function. Never throws out of the loop —
 * every failure is logged and retried on the next tick.
 *
 * Deliberately a RECURSIVE setTimeout (Phase 1 overlap-safety — same fix as
 * enrollment.ts's startHeartbeat, same reasoning): the next tick is only
 * ever SCHEDULED once the current one (which can itself drain up to
 * MAX_CLAIMS_PER_TICK submissions, each a network round-trip) has fully
 * settled, so two ticks can never run concurrently. The previous
 * implementation (`setInterval` PLUS a separate immediate `tick()` call)
 * could overlap the immediate call with the first interval firing if that
 * immediate call was still draining a backlog — structurally impossible now.
 */
export function startDeliveryPoller(options: DeliveryPollerOptions): () => void {
  const localRootConfig = options.localRootConfig ?? loadLocalRootConfig();
  let notConfiguredWarned = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    const root = resolveLocalStorageRoot(localRootConfig);
    const storageRootIds = options.storageRegistry?.ids() ?? [];
    if (!root && storageRootIds.length === 0) {
      if (!notConfiguredWarned) {
        options.log(
          '[Storage] No local storage root configured yet (waiting for Electron\'s "Select Folder", or ' +
            'AGENT_LOCAL_STORAGE_ROOT) and no folder is authorized for writing — pending submissions will wait.',
        );
        notConfiguredWarned = true;
      }
      return;
    }
    notConfiguredWarned = false;
    // Only work this Gateway can actually perform is ever handed to it.
    const capabilities = { central: root !== null, storageRootIds };

    for (let i = 0; i < MAX_CLAIMS_PER_TICK; i += 1) {
      const claimed = await options.client.claimSubmission(options.deviceToken, capabilities).catch((err: unknown) => {
        options.log(`[Agent] Could not reach the backend to claim a submission (will retry): ${describeError(err)}`);
        return null;
      });
      if (!claimed) return; // network error — try again next tick
      if (!claimed.ready) {
        if (claimed.reason === 'NOT_CONFIGURED') {
          options.log('[Storage] This tenant has no Central DPDP Storage root configured centrally yet — waiting.');
        }
        return; // nothing more to claim this tick
      }

      options.log(`[Agent] Claiming submission delivery=${claimed.deliveryId}`);
      if (claimed.target === 'gateway') {
        let r: { written: number; alreadyPresent: number };
        try {
          r = await writeGatewayCopy(options.storageRegistry, claimed);
        } catch (err) {
          const reason = describeWriteError(err);
          options.log(`[Submission] Enterprise copy failed delivery=${claimed.deliveryId} error=${reason}`);
          await options.client
            .failSubmission(options.deviceToken, claimed.deliveryId, reason)
            .catch((failErr: unknown) => options.log(`[Agent] Could not report the failure to the backend: ${describeError(failErr)}`));
          continue;
        }
        // The files ARE written. If only the acknowledgement is lost, DPDP
        // keeps reporting the copy as pending and offers it again later; the
        // retry finds the files already there and acknowledges then — so a
        // write is never reported as failed, nor duplicated.
        try {
          await options.client.ackSubmission(options.deviceToken, claimed.deliveryId);
          options.log(`[Submission] Delivered Enterprise copy delivery=${claimed.deliveryId} written=${r.written} alreadyPresent=${r.alreadyPresent}`);
        } catch (err) {
          options.log(`[Agent] Enterprise copy written but not yet acknowledged delivery=${claimed.deliveryId} (will be confirmed on retry): ${describeError(err)}`);
        }
        continue;
      }
      try {
        if (!root) throw new Error('NOT_CONFIGURED'); // never offered when central=false; defensive only
        await writeClaimedSubmission(root, claimed);
        await options.client.ackSubmission(options.deviceToken, claimed.deliveryId);
        options.log(`[Submission] Delivered delivery=${claimed.deliveryId} folder="${claimed.folderName}"`);
      } catch (err) {
        const reason = describeError(err);
        options.log(`[Submission] Delivery failed delivery=${claimed.deliveryId} error=${reason}`);
        await options.client
          .failSubmission(options.deviceToken, claimed.deliveryId, reason)
          .catch((failErr: unknown) => options.log(`[Agent] Could not report the failure to the backend: ${describeError(failErr)}`));
      }
    }
  };

  const runTick = (): void => {
    tick()
      .catch((err: unknown) => options.log(`[Agent] Delivery poll tick failed unexpectedly: ${describeError(err)}`))
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(runTick, options.pollIntervalSeconds * 1000);
        timer.unref?.();
      });
  };

  // Runs once immediately (so a backlog starts draining without waiting for
  // the first interval), then recursively reschedules — see this function's
  // own header for why that makes overlap impossible rather than just rare.
  runTick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Writes an Enterprise copy through the storage plane's provider, in this
 * process (no HTTP hop). Every guarantee comes from the existing storage
 * plane, not from this function:
 *   - registry.get() throws STORAGE_ROOT_NOT_AUTHORIZED for any location the
 *     administrator did not explicitly authorize for writing;
 *   - createFolder/writeFile re-check containment (symlinks resolved), name
 *     safety, size, and never overwrite.
 * The mapped folder path is created if missing (createFolder is idempotent
 * and contained). A file that already exists under its submission+field
 * name is a previous attempt of THIS delivery that completed (writes are
 * atomic, so an existing file is never partial) — counted, not rewritten,
 * so a retry after a lost acknowledgement creates no duplicate.
 */
export async function writeGatewayCopy(
  registry: StorageRegistry | undefined,
  claimed: ClaimedGatewayCopy,
): Promise<{ written: number; alreadyPresent: number }> {
  if (!registry) throw new StorageNotConfiguredError();
  const provider = registry.get(claimed.storageRootId);
  let written = 0;
  let alreadyPresent = 0;
  for (const file of claimed.files) {
    for (let i = 0; i < file.path.length; i += 1) {
      await provider.createFolder(file.path.slice(0, i), file.path[i]!);
    }
    try {
      await provider.writeFile(file.path, file.filename, file.contentBase64, false);
      written += 1;
    } catch (err) {
      if ((err as { code?: string }).code !== 'FILE_ALREADY_EXISTS') throw err;
      alreadyPresent += 1;
    }
  }
  return { written, alreadyPresent };
}

/** A stable code only (e.g. PERMISSION_DENIED, PATH_NOT_ALLOWED) — a Node fs
 *  error message names the OS path, which never leaves the Gateway. */
function describeWriteError(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code)) return code;
  return 'WRITE_FAILED';
}

async function writeClaimedSubmission(root: string, claimed: ClaimedCentralSubmission): Promise<void> {
  const infoSegments = [CUSTOMERS_FOLDER_NAME, claimed.folderName, CUSTOMER_INFORMATION_FOLDER_NAME];
  await writeJsonFile(root, infoSegments, 'profile.json', {
    customerId: claimed.customerId,
    subjectRef: claimed.subjectRef,
    displayName: claimed.displayName,
    createdAt: new Date().toISOString(),
  });
  if (claimed.retentionMonths !== null) {
    await writeJsonFile(root, infoSegments, 'retention.json', {
      templateName: claimed.templateName,
      retentionMonths: claimed.retentionMonths,
    });
  }

  for (const field of claimed.fields) {
    const segments = [
      CUSTOMERS_FOLDER_NAME,
      claimed.folderName,
      CONSENT_REGISTER_FOLDER_NAME,
      sanitizeLabel(claimed.templateName),
      sanitizeLabel(field.label),
    ];
    if (field.file) {
      await writeRawFile(root, segments, field.file.filename || 'value', Buffer.from(field.file.contentBase64, 'base64'));
    } else if (field.textValue !== undefined && field.textValue.trim().length > 0) {
      await writeTextFile(root, segments, 'value.txt', field.textValue);
    }
  }
}

/** Sanitized for the backend's fail() call and local logs — a Node fs error
 *  message may include the OS path but never customer content (a path
 *  segment here is a folder/field NAME, not a field value). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
