import { Module } from '@nestjs/common';
import { AesGcmSecretCipher, SECRET_CIPHER } from '../identity/crypto/secret-cipher';
import { WebhookConfigController } from './webhook-config.controller';
import { WebhookConfigRepository } from './webhook-config.repository';
import { WebhookSecretsRepository } from './webhook-secrets.repository';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { NotificationDispatcher } from './notification-dispatcher';

/**
 * Notifications. Transactional email (deadline alerts, acknowledgements, breach
 * notices), SMS/WhatsApp for OTP and urgent escalation (India: MSG91 / Gupshup),
 * and signed outbound webhooks to clients (consent changes, fulfilment requests).
 * A shared service used by Consent, Breach, Grievance, and DPRequest (R2).
 *
 * Requirements: FR-DSH-02/03, FR-CON-07, FR-DPR-05/08.
 *
 * The webhook half (FR-CON-07) is real as of Prompt 22: WebhookDeliveryService
 * is the scheduling half, exported for ConsentModule to call. The consuming
 * half — WebhookDeliveryWorker, which signs and POSTs — is deliberately NOT a
 * provider here; like WorkflowWorker, it is registered only in WorkerModule,
 * so the signing secret and the outbound HTTP call to a client-controlled URL
 * never execute in the API process. Email/SMS remain skeleton (no providers).
 *
 * PgBossService is injected without importing WorkflowModule: it is @Global
 * and exports PgBossService precisely so a second durable-job use case (this
 * one) can reuse the same engine/connection pool instead of standing up
 * another.
 *
 * SECRET_CIPHER is bound HERE, directly to the same AesGcmSecretCipher class
 * IdentityModule uses — NOT by `imports: [IdentityModule]`, unlike
 * ConsentModule's identical need. That is a deliberate deviation: this module
 * is loaded in BOTH processes (the API schedules deliveries, WorkerModule
 * imports it for the worker's repositories — see worker.module.ts), and
 * IdentityModule pulls in IdentityService, which depends on the @Global
 * AuditContextService — available in the API's module graph, but never
 * loaded into the worker's. Importing IdentityModule here would boot-crash
 * the worker process the moment WorkerModule resolves this module's graph.
 * A second stateless binding of the same cipher class costs nothing (it
 * wraps one key from the environment either way) and keeps the worker
 * process free of identity/auth machinery it has no business touching.
 */
@Module({
  controllers: [WebhookConfigController],
  providers: [
    { provide: SECRET_CIPHER, useClass: AesGcmSecretCipher },
    WebhookConfigRepository,
    WebhookSecretsRepository,
    WebhookDeliveriesRepository,
    WebhookDeliveryService,
    // Transactional email/SMS (FR-GRV-01/05, FR-DSH-02/03). Unlike the webhook
    // pipeline this has no worker half: an OTP is worthless a minute late, so it
    // is sent inline and best-effort rather than queued. Registered in BOTH
    // processes — the API sends OTPs, the worker sends escalation alerts.
    NotificationDispatcher,
  ],
  // Repositories are exported too (not just the service) so WorkerModule's
  // WebhookDeliveryWorker — a provider of a DIFFERENT module — can use them
  // without this module reaching into the worker's process, mirroring exactly
  // how WorkflowModule exports WorkflowJobsRepository for WorkflowWorker.
  exports: [
    WebhookDeliveryService,
    WebhookConfigRepository,
    WebhookSecretsRepository,
    WebhookDeliveriesRepository,
    NotificationDispatcher,
  ],
})
export class NotifyModule {}
