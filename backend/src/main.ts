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

  // CORS for the Next.js frontend (a separate origin in Stage 1: web on :3000,
  // api on :3001). Bearer tokens live in the Authorization header, not cookies,
  // so no credentials flag is needed. Origin allow-list comes from env; it
  // defaults to the local web dev origin.
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({
    origin: webOrigin.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`DPDP API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
