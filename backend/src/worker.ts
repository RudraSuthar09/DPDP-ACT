import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint — the second Stage 1 container. Runs background jobs and
 * deadline tickers behind the WorkflowRunner seam (S3): BullMQ consumers,
 * SLA/deadline ticks for Breach, Grievance, and DPRequest. No HTTP listener.
 *
 * Job processors are NOT implemented yet — this is the skeleton that gives the
 * worker its own process so deadline workflows never share the request path.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('DPDP worker started (no processors registered yet)', 'Worker');
}

void bootstrap();
