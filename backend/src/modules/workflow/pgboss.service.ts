import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';
import { WORKFLOW_QUEUE } from './workflow.constants';
import { pgConnectionOptions } from '../../database/pg-tls';

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
 *
 * LEAST PRIVILEGE (optional, recommended in production): PGBOSS_DATABASE_URL.
 * pg-boss never needs the owner's rights over the TENANT schema — only over its
 * own `pgboss` schema. Point PGBOSS_DATABASE_URL at a dedicated role that owns
 * `pgboss` and nothing else (docs/pgboss-least-privilege.sql) and the running
 * API and worker no longer hold the owner credential at all; only the
 * migration task does. Unset, it falls back to DATABASE_URL, exactly as before.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossService.name);
  private boss: PgBoss | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.get<string>('PGBOSS_DATABASE_URL') || this.config.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'PGBOSS_DATABASE_URL (or, failing that, DATABASE_URL) is required for the pg-boss engine behind the ' +
          'WorkflowRunner (S3). pg-boss manages its own schema and needs DDL rights over it.',
      );
    }

    const boss = new PgBoss({
      // TLS verified against DATABASE_SSL_CA_FILE when set (see pg-tls.ts).
      ...pgConnectionOptions(connectionString, this.config.get<string>('DATABASE_SSL_CA_FILE')),
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
