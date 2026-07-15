import { Module } from '@nestjs/common';

/**
 * Consent Register. Ingests consent events (REST + JS SDK), pseudonymises the
 * subject reference (per-tenant HMAC, I2), and appends through the EventSink
 * seam (S2) into a bitemporal, append-only, partitioned store. A withdrawal is
 * a NEW event, never an update (FR-CON-05). Notice versioning is non-negotiable.
 *
 * Requirements: FR-CON-01..09.  Seams: S2.  Invariants: I2, I4.
 * Skeleton only — no providers or controllers yet.
 */
@Module({})
export class ConsentModule {}
