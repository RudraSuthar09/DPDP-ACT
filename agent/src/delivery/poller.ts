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
import type { ClaimedSubmission, GatewayControlPlaneClient } from '../enrollment';
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
    if (!root) {
      if (!notConfiguredWarned) {
        options.log(
          '[Storage] No local storage root configured yet (waiting for Electron\'s "Select Folder", or ' +
            'AGENT_LOCAL_STORAGE_ROOT) — pending submissions will wait.',
        );
        notConfiguredWarned = true;
      }
      return;
    }
    notConfiguredWarned = false;

    for (let i = 0; i < MAX_CLAIMS_PER_TICK; i += 1) {
      const claimed = await options.client.claimSubmission(options.deviceToken).catch((err: unknown) => {
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
      try {
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

async function writeClaimedSubmission(root: string, claimed: Extract<ClaimedSubmission, { ready: true }>): Promise<void> {
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
