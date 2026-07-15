import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * HTTP application entrypoint — the "app" container (one of two in Stage 1).
 * The "worker" container boots from worker.ts. Both share the same modules;
 * only the entrypoint differs (§ deploy: two containers, not Kubernetes).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`DPDP API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
