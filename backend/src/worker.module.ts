import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/**
 * Root module for the worker process. In Stage 1 the worker will host the
 * BullMQ processors and the deadline ticker behind the WorkflowRunner seam (S3).
 * Kept minimal here — no processors are registered yet.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] })],
})
export class WorkerModule {}
