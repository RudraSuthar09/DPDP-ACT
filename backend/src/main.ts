import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/**
 * HTTP application entrypoint — the "app" container (one of two in Stage 1).
 * The "worker" container boots from worker.ts. Both share the same modules;
 * only the entrypoint differs (§ deploy: two containers, not Kubernetes).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  // CORS is branched by path, not one static policy, because this API now
  // serves two very different kinds of caller:
  //   - the Next.js frontend: one known origin (WEB_ORIGIN), bearer tokens in
  //     the Authorization header, never cookies — the original policy.
  //   - the Consent SDK's public routes (/consent/public/*, FR-CON-09): called
  //     from whatever third-party website a tenant embeds it on, which is not
  //     knowable in advance. Those need any origin reflected back, and a
  //     different credential header (X-Consent-Api-Key) instead of Authorization.
  // One enableCors call with a delegate keeps this a single, explicit,
  // reviewable branch rather than two competing cors() middlewares.
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const webOrigins = webOrigin.split(',').map((o) => o.trim());
  app.enableCors((req, callback) => {
    const isPublicConsentRoute = (req.url ?? '').startsWith('/consent/public/');
    callback(
      null,
      isPublicConsentRoute
        ? {
            origin: true,
            methods: ['POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'X-Consent-Api-Key', 'x-correlation-id'],
          }
        : {
            origin: webOrigins,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
          },
    );
  });

  // FR-CON-09: the built Consent SDK, served as a static asset. "CDN-delivered"
  // per the requirement is not literally true yet — there is no CDN anywhere
  // in Stage 1's infra, and standing one up is a deployment decision outside
  // this repo. This is the Stage-1 stand-in a real CDN can front later with
  // zero application-code change: a versioned path (v1) so a v2 can ship
  // without breaking a script tag already live on a client's site.
  app.useStaticAssets(path.resolve(process.cwd(), '..', 'sdk', 'dist'), {
    prefix: '/consent-sdk/v1/',
    maxAge: '1h',
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`DPDP API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
