import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { webOrigins } from './web-origins';
import { parseTrustProxy } from './config/env.validation';

/**
 * HTTP application entrypoint — the "app" container (one of two in Stage 1).
 * The "worker" container boots from worker.ts. Both share the same modules;
 * only the entrypoint differs (§ deploy: two containers, not Kubernetes).
 */
async function bootstrap(): Promise<void> {
  // bodyParser: false + explicit json()/urlencoded() below, so the limit can
  // be raised once, app-wide, from Express's 100kb default — needed for the
  // hosted consent-form submit route, which base64-encodes a PDF/Excel field
  // value into the JSON body for the synchronous Enterprise storage write
  // (see EnterpriseStorageSyncService; each file is separately capped at 8MB
  // decoded in consent-forms.dto.ts's parseLinkSubmission, well under this).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Behind a load balancer every request arrives from the balancer, so the
  // per-IP rate limits (public forms, request portal) would see ONE client and
  // throttle every visitor together. TRUST_PROXY=<hop count> makes req.ip the
  // real client again. Unset = off (Express's default), which is correct with
  // nothing in front — locally, and for the customer installer. Validated at
  // startup (config/env.validation.ts), so an invalid value never reaches here.
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY) ?? false);
  app.use(json({ limit: '30mb' }));
  app.use(urlencoded({ extended: true, limit: '30mb' }));
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
  const dashboardOrigins = webOrigins();
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
            origin: dashboardOrigins,
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
  // The port only — inside a container or behind a load balancer, a
  // "http://localhost:..." line would point operators at an address that does
  // not reach this process.
  Logger.log(`DPDP API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
