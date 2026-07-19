import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { ConsentRepository } from './consent.repository';
import { SubjectRefHasher } from './subject-ref';
import { EVENT_SINK, PostgresEventSink } from './postgres-event-sink';

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
  controllers: [ConsentController],
  providers: [
    ConsentService,
    ConsentRepository,
    SubjectRefHasher,
    { provide: EVENT_SINK, useClass: PostgresEventSink },
  ],
})
export class ConsentModule {}
