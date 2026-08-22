import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { NotifyModule } from '../notify/notify.module';
import { InventoryModule } from '../inventory/inventory.module';
import { DataPrincipalModule } from '../data-principal/data-principal.module';
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
import { ConsentFormsController } from './consent-forms.controller';
import { ConsentFormsPublicController } from './consent-forms-public.controller';
import { ConsentFormsPortalController } from './consent-forms-portal.controller';
import { ConsentFormsService } from './consent-forms.service';
import { ConsentFormsRepository } from './consent-forms.repository';
import { ConsentInventoryLinkRepository } from './consent-inventory-link.repository';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';
import { RetentionRepository } from './retention.repository';

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
  // InventoryModule for EntryPurposesService — the consent-form builder links a
  // row directly to a Data Inventory element and needs that element's purpose
  // ids (through a service, never the table — R2). Inventory does not import
  // Consent, so this is not circular.
  // DataPrincipalModule for DataPrincipalService — ConsentFormsService.submit()
  // resolves the customer/data-principal UUID identity here (never invents one
  // inline), the same registry Grievance/DSR/Breach/Data Inventory will later
  // import too (R2 — one identity mechanism, not one per module).
  imports: [IdentityModule, NotifyModule, InventoryModule, DataPrincipalModule],
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
    // Consent forms (widget + hosted-link distribution): three controllers,
    // one staff-JWT and two public (publishable-key and slug), all sharing
    // ConsentFormsService via same-module DI for the same reason the SDK's
    // routes do — see ConsentFormsService's header (R3: no second write path).
    ConsentFormsController,
    ConsentFormsPublicController,
    ConsentFormsPortalController,
    RetentionController,
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
    ConsentFormsService,
    ConsentFormsRepository,
    ConsentInventoryLinkRepository,
    RetentionService,
    RetentionRepository,
  ],
  // ConsentService only — never ConsentRepository, ConsentNoticesRepository, or
  // EVENT_SINK. It exposes the active-consents counter (FR-DSH-01) to the
  // Dashboard module without letting anyone reach the event table or the write
  // path directly (R2/R3). Notices have no cross-module consumer yet, so
  // nothing of theirs is exported either — add it the day something needs it.
  // RetentionService is exported too, so the Dashboard module can read the
  // "approaching / past retention" counters (FR-DSH) through a service, never the
  // retention table (R2).
  exports: [ConsentService, RetentionService],
})
export class ConsentModule {}
