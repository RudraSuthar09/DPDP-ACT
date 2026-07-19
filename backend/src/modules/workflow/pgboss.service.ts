import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';
import { WORKFLOW_QUEUE } from './workflow.constants';

/**
 * The pg-boss engine, wrapped as a Nest lifecycle service. pg-boss is a durable
 * job queue that lives ENTIRELY in Postgres — no Redis, no extra infra. It is the
 * Stage-1 mechanism behind the WorkflowRunner (S3): a jobs table, a worker, and a
 * polling engine that fires jobs at their scheduled time. Later this whole class
 * is replaced by a Temporal client behind the same WorkflowRunner interface.
 *
 * WHY THE OWNER CONNECTION (and why that is not an S1 hole)
 *
 * pg-boss manages its OWN schema (`pgboss`) and tables, which means it needs DDL
 * rights to create them — so it connects as dpdp_owner (DATABASE_URL), not the
 * runtime dpdp_app role. This is safe because:
 *   - pg-boss only ever touches its own `pgboss` schema — never a tenant table.
 *   - dpdp_owner is NOSUPERUSER NOBYPASSRLS and every tenant table is FORCE RLS,
 *     so even this connection cannot read another tenant's business data.
 * All tenant-scoped work still goes exclusively through dpdp_app under RLS
 * (TenantDatabaseService). The job queue is infrastructure; it carries ids and
 * metadata only (I1), never a customer record.
 *
 * (On managed Postgres where dpdp_owner cannot create schemas, provision the
 * `pgboss` schema out-of-band, exactly as the `app` schema is — see the bootstrap
 * migration's portability note.)
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossService.name);
  private boss: PgBoss | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL (the owner connection) is required for the pg-boss engine behind the ' +
          'WorkflowRunner (S3). pg-boss manages its own schema and needs DDL rights to create it.',
      );
    }

    const boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      // A recognisable name in pg_stat_activity so this pool is never confused
      // with the tenant-data pool (dpdp_app).
      application_name: 'dpdp-workflow-pgboss',
    });
    boss.on('error', (err) => this.logger.error(`pg-boss engine error: ${String(err)}`));

    await boss.start();
    // v10 requires queues to exist before send/work. Idempotent.
    await boss.createQueue(WORKFLOW_QUEUE);
    this.boss = boss;
    this.logger.log(`pg-boss started (schema=pgboss, queue=${WORKFLOW_QUEUE})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) {
      await this.boss.stop({ graceful: true }).catch((err) => {
        this.logger.warn(`pg-boss stop failed: ${String(err)}`);
      });
      this.boss = null;
    }
  }

  /** The started engine. Throws if used before onModuleInit — a programming error. */
  get instance(): PgBoss {
    if (!this.boss) {
      throw new Error('pg-boss is not started yet (PgBossService.onModuleInit has not run).');
    }
    return this.boss;
  }
}
