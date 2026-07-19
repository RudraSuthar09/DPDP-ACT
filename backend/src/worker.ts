import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint — the second Stage 1 container. Runs the consuming half of
 * the WorkflowRunner seam (S3): the pg-boss deadline handler and the
 * reconciliation ticker for Breach, Grievance, and DPRequest. No HTTP listener,
 * so deadline workflows never share the request path.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('DPDP worker started: WorkflowRunner consumer + deadline ticker (S3)', 'Worker');
}

void bootstrap();
