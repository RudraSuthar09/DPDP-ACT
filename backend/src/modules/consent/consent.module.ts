import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { NotifyModule } from '../notify/notify.module';
import { TenantConsentSecretsRepository } from './tenant-consent-secrets.repository';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { ConsentRepository } from './consent.repository';
import { SubjectRefHasher } from './subject-ref';
import { EVENT_SINK, PostgresEventSink } from './postgres-event-sink';
import { ConsentNoticesController } from './consent-notices.controller';
import { ConsentNoticesService } from './consent-notices.service';
import { ConsentNoticesRepository } from './consent-notices.repository';
import { ConsentProofController } from './consent-proof.controller';
import { ConsentProofService } from './consent-proof.service';
import { ConsentPublicController } from './consent-public.controller';
import { ConsentApiKeysController } from './consent-api-keys.controller';
import { ConsentApiKeysService } from './consent-api-keys.service';
import { ConsentApiKeysRepository } from './consent-api-keys.repository';

/**
 * Consent Register — Seam S2. Ingests consent events, pseudonymises the subject
 * (per-tenant HMAC, I2), and appends through the EventSink into a bitemporal,
 * append-only, partitioned store. A withdrawal is a NEW event, never an update
 * (FR-CON-05). Notice versioning is non-negotiable (FR-CON-02).
 *
 * Requirements: FR-CON-01..08.  Seams: S2.  Invariants: I2, I4.
 *
 * ---------------------------------------------------------------------------
 * THE `providers` LIST IS A SECURITY CONTROL — like the audit module's.
 *
 * EVENT_SINK is provided here and deliberately NOT exported. It is the only thing
 * that can append a consent event, and because Nest resolves providers through
 * module boundaries, a service in another module that tries to inject it fails to
 * boot with an unresolved dependency — not a lint warning, a dead application in
 * CI. "Consent events are written only through the sink" (R3) is therefore
 * enforced by the injector, not by anyone remembering.
 *
 * Later, only the useClass on EVENT_SINK changes (PostgresEventSink →
 * KafkaEventSink). The consent module never learns it happened — that is the seam.
 * ---------------------------------------------------------------------------
 */
@Module({
  // IdentityModule for SECRET_CIPHER — per-tenant subject-ref secrets are
  // encrypted at rest with the same cipher that protects TOTP secrets, rather
  // than this module growing a second one (NFR-SEC-03). NotifyModule for
  // WebhookDeliveryService — every consent change schedules a signed webhook
  // (FR-CON-07) through ConsentService, never by this module reaching into
  // notify's tables directly (R2).
  imports: [IdentityModule, NotifyModule],
  controllers: [
    ConsentController,
    ConsentNoticesController,
    ConsentProofController,
    // FR-CON-09: the SDK's own routes (key-authenticated) and the staff-facing
    // key management routes (JWT-authenticated) — two different auth stories,
    // both living here so they get ConsentService/SubjectRefHasher via
    // ordinary same-module DI rather than widening ConsentModule's exports.
    ConsentPublicController,
    ConsentApiKeysController,
  ],
  providers: [
    ConsentService,
    ConsentRepository,
    SubjectRefHasher,
    TenantConsentSecretsRepository,
    { provide: EVENT_SINK, useClass: PostgresEventSink },
    ConsentNoticesService,
    ConsentNoticesRepository,
    ConsentProofService,
    ConsentApiKeysService,
    ConsentApiKeysRepository,
  ],
  // ConsentService only — never ConsentRepository, ConsentNoticesRepository, or
  // EVENT_SINK. It exposes the active-consents counter (FR-DSH-01) to the
  // Dashboard module without letting anyone reach the event table or the write
  // path directly (R2/R3). Notices have no cross-module consumer yet, so
  // nothing of theirs is exported either — add it the day something needs it.
  exports: [ConsentService],
})
export class ConsentModule {}
