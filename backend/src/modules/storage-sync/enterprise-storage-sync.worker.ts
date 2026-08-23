import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EnterpriseStorageSyncService } from './enterprise-storage-sync.service';

/** How often the worker sweeps every tenant with an active 'server' storage
 *  root for pending submissions — same idiom, same order of magnitude as
 *  WorkflowWorker's reconciliation ticker (workflow.constants.ts), reused
 *  here rather than introducing any new job infrastructure. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * The consuming half of Enterprise automatic sync — registered ONLY in
 * WorkerModule (never the API), exactly like WorkflowWorker. A plain
 * `setInterval` sweep, no queue: the "instant" case (a submission arriving
 * while the path is reachable) is already handled SYNCHRONOUSLY in the API
 * process by ConsentFormsService.submit() -> EnterpriseStorageSyncService.
 * writeSubmissionFieldsNow(). This ticker exists only for the 24/7 catch-up
 * story section 7/14A/15 of the spec asks for: a submission that arrived
 * while the path was unreachable, or while the worker itself was down, is
 * picked up and its Customer Information filed the moment the path (or the
 * worker) is back — without anyone opening the DPDP dashboard.
 */
@Injectable()
export class EnterpriseStorageSyncWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EnterpriseStorageSyncWorker.name);
  private ticker: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly sync: EnterpriseStorageSyncService) {}

  onApplicationBootstrap(): void {
    this.ticker = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.logger.log(`Enterprise storage sync worker up: sweeping every ${SWEEP_INTERVAL_MS / 1000}s`);
    // Sweep once immediately so submissions that arrived while the worker was
    // down (or the storage path was unreachable) are picked up on restart,
    // not on the next tick — the same reasoning as WorkflowWorker's startup sweep.
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return; // never let two sweeps overlap
    this.sweeping = true;
    try {
      const tenantIds = await this.sync.listTenantsWithServerStorage();
      for (const tenantId of tenantIds) {
        try {
          const { synced, failed } = await this.sync.syncTenant(tenantId);
          if (synced > 0 || failed > 0) {
            this.logger.log(`Enterprise sync (tenant ${tenantId.slice(0, 8)}…): ${synced} synced, ${failed} failed.`);
          }
        } catch (err) {
          this.logger.error(`Enterprise sync sweep failed for tenant ${tenantId.slice(0, 8)}…: ${String(err)}`);
        }
      }
    } catch (err) {
      this.logger.error(`Enterprise sync sweep could not list tenants: ${String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }
}
