import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import { acquireWorkerLeadership, leadershipClient } from './worker-leadership';
import { pgConnectionOptions } from './database/pg-tls';

/**
 * Worker entrypoint — the second Stage 1 container. Runs the consuming half of
 * the WorkflowRunner seam (S3): the pg-boss deadline handler and the
 * reconciliation ticker for Breach, Grievance, and DPRequest. No HTTP listener,
 * so deadline workflows never share the request path.
 *
 * Exactly one worker is ever ACTIVE (worker-leadership.ts): nothing below —
 * not pg-boss, not a ticker — starts until this process holds the worker lock.
 * A second worker started by mistake stands by instead of duplicating work.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // The lock needs the runtime connection before Nest's ConfigModule exists.
  // Environment validation runs when WorkerModule is imported (already done by
  // the import above), so a missing APP_DATABASE_URL has stopped us by now.
  const connectionString = process.env.APP_DATABASE_URL ?? '';
  let stop: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => (stop = resolve));
  const onSignal = () => stop();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  const leadership = await acquireWorkerLeadership({
    client: leadershipClient(
      pgConnectionOptions(connectionString, process.env.DATABASE_SSL_CA_FILE),
    ),
    log: (m) => logger.log(m),
    stopSignal,
  });
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  if (!leadership) {
    logger.log('Stopped while standing by; never became active.');
    return;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Shutdown is handled here rather than by app.enableShutdownHooks(): Nest's
  // handler closes the app and then re-raises the signal, which would end the
  // process before the lock is released in order. app.close() runs the same
  // hooks (pg-boss graceful stop, tickers cleared); the lock is released only
  // AFTER, so a successor can never start while this one is mid-job.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close().catch((err) => logger.error(`Shutdown error: ${String(err)}`));
    await leadership.release();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  logger.log('DPDP worker started: WorkflowRunner consumer + deadline ticker (S3)');
}

void bootstrap();
