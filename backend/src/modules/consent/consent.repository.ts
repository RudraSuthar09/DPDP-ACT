import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ConsentStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Every SQL statement the consent module issues that is NOT an event append.
 *
 * Appends do not live here — they go through the EventSink (S2), which is the
 * whole point of the seam. This file holds the ordinary reads and the consent
 * PURPOSE definitions (FR-CON-01), which are plain tenant metadata, not events.
 * No other module touches these tables (R2): they call ConsentService.
 *
 * Purposes (FR-CON-01, Prompt 18) are now a proper lifecycle + versioned
 * entity — same split as inventory_register_entries/_versions:
 * `consent_purposes` is lifecycle only (active/tombstoned), and
 * `consent_purpose_versions` is the append-only content history. See
 * 1737001300000_consent-purposes-and-notices.sql for why, and for the
 * backfill that keeps every purpose consent_events already references (via
 * its untouched `purpose_id` FK) resolvable through the new version join.
 */

/** The full purpose lifecycle row — active/tombstoned, never hard-deleted (I4). */
export interface ConsentPurposeRow {
  id: string;
  status: 'active' | 'tombstoned';
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_at: Date;
  updated_at: Date;
  /** DEPRECATED (pre-versioning) — frozen for purposes created before Prompt 18.
   *  NULL on every purpose created since; the current name lives on
   *  consent_purpose_versions.purpose_name. Never rewritten (I4). */
  name: string | null;
}

export interface ConsentPurposeVersionRow {
  id: string;
  purpose_id: string;
  version_number: number;
  purpose_name: string;
  description: string | null;
  created_at: Date;
  created_by: string | null;
}

export interface ConsentPurposeFields {
  name: string;
  description: string | null;
}

/** One row of the purpose list: lifecycle + its current (latest) version. */
export interface ConsentPurposeListRow {
  id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
  updated_at: Date;
  version_number: number;
  name: string;
  description: string | null;
  version_created_at: Date;
}

/** The minimal projection `recordConsent()` needs: does this purpose id exist,
 *  and what should the audit reason call it. Deliberately NOT the full
 *  lifecycle row — this keeps the EventSink-adjacent write path's shape
 *  exactly as it was before purposes gained versioning. */
export interface ConsentPurposeRef {
  id: string;
  name: string;
}

export interface ConsentEventRow {
  id: string;
  subject_ref: string;
  purpose_id: string;
  purpose_name: string | null;
  /** A real consent_notice_versions id. NULL only on pre-FR-CON-02 rows. */
  notice_version_id: string | null;
  /** Frozen free-text notice ref from before notices existed. Never rewritten. */
  legacy_notice_version_ref: string | null;
  status: ConsentStatus;
  occurred_at: Date;
  recorded_at: Date;
  source: string;
  evidence_hash: string;
  evidence_hash_origin: 'client' | 'platform';
}

/** What `recordConsent` must know before it writes: that the purpose is real
 *  and active, what it is called (for the audit reason), and that the notice
 *  version is a notice OF that purpose. One round trip, not three. */
export interface ConsentIngestTargets {
  purposeName: string;
  purposeStatus: 'active' | 'tombstoned';
  noticeBelongsToPurpose: boolean;
}

@Injectable()
export class ConsentRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- purposes (FR-CON-01) ---------------------------------------------------

  /** Create a purpose and its first version (version_number = 1) together. */
  createPurpose(
    fields: ConsentPurposeFields,
    actorId: string | null,
  ): Promise<{ purpose: ConsentPurposeRow; version: ConsentPurposeVersionRow }> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<ConsentPurposeRow>(
        `INSERT INTO consent_purposes DEFAULT VALUES RETURNING *`,
      );
      const purpose = purposeRows[0]!;

      const { rows: versionRows } = await client.query<ConsentPurposeVersionRow>(
        `INSERT INTO consent_purpose_versions (purpose_id, version_number, purpose_name, description, created_by)
         VALUES ($1, 1, $2, $3, $4)
         RETURNING *`,
        [purpose.id, fields.name, fields.description, actorId],
      );

      return { purpose, version: versionRows[0]! };
    });
  }

  /** Every purpose (optionally including tombstoned), current version. */
  listPurposes(includeTombstoned: boolean): Promise<ConsentPurposeListRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentPurposeListRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (p.id)
             p.id, p.status, p.created_at, p.updated_at,
             v.version_number, v.purpose_name AS name, v.description,
             v.created_at AS version_created_at
           FROM consent_purposes p
           JOIN consent_purpose_versions v ON v.purpose_id = p.id
           ${includeTombstoned ? '' : "WHERE p.status = 'active'"}
           ORDER BY p.id, v.version_number DESC
         ) latest
         ORDER BY latest.name, latest.created_at`,
      );
      return rows;
    });
  }

  /** One purpose plus its full version history, newest first. */
  findPurposeDetail(
    purposeId: string,
  ): Promise<{ purpose: ConsentPurposeRow; versions: ConsentPurposeVersionRow[] } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<ConsentPurposeRow>(
        `SELECT * FROM consent_purposes WHERE id = $1`,
        [purposeId],
      );
      const purpose = purposeRows[0];
      if (!purpose) {
        return null;
      }

      const { rows: versions } = await client.query<ConsentPurposeVersionRow>(
        `SELECT * FROM consent_purpose_versions
          WHERE purpose_id = $1
          ORDER BY version_number DESC`,
        [purposeId],
      );

      return { purpose, versions };
    });
  }

  /** Append a new version. Returns null if the purpose doesn't exist or is tombstoned. */
  updatePurpose(
    purposeId: string,
    fields: ConsentPurposeFields,
    actorId: string | null,
  ): Promise<{ previous: ConsentPurposeVersionRow; next: ConsentPurposeVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<ConsentPurposeRow>(
        `SELECT * FROM consent_purposes WHERE id = $1 FOR UPDATE`,
        [purposeId],
      );
      const purpose = purposeRows[0];
      if (!purpose || purpose.status !== 'active') {
        return null;
      }

      const { rows: prevRows } = await client.query<ConsentPurposeVersionRow>(
        `SELECT * FROM consent_purpose_versions
          WHERE purpose_id = $1
          ORDER BY version_number DESC
          LIMIT 1`,
        [purposeId],
      );
      const previous = prevRows[0]!;
      const nextNumber = previous.version_number + 1;

      const { rows: nextRows } = await client.query<ConsentPurposeVersionRow>(
        `INSERT INTO consent_purpose_versions (purpose_id, version_number, purpose_name, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [purposeId, nextNumber, fields.name, fields.description, actorId],
      );

      await client.query(`UPDATE consent_purposes SET updated_at = now() WHERE id = $1`, [purposeId]);

      return { previous, next: nextRows[0]! };
    });
  }

  /** Soft-delete. Returns null if the purpose doesn't exist or is already tombstoned. */
  tombstonePurpose(
    purposeId: string,
    reason: string | null,
    actorId: string | null,
  ): Promise<ConsentPurposeRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentPurposeRow>(
        `UPDATE consent_purposes
            SET status = 'tombstoned',
                tombstone_reason = $2,
                tombstoned_at = now(),
                tombstoned_by = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [purposeId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Does this purpose id exist, and what is it currently called — the one
   * thing `recordConsent()` needs before it writes an event through the
   * EventSink. Reads through the version join (purposes no longer carry
   * their name directly) but keeps the exact `{id, name}` shape the
   * EventSink-adjacent write path already depended on, so that path did not
   * need to change at all.
   */
  async findPurpose(client: PoolClient, purposeId: string): Promise<ConsentPurposeRef | null> {
    const { rows } = await client.query<ConsentPurposeRef>(
      `SELECT p.id, v.purpose_name AS name
         FROM consent_purposes p
         JOIN consent_purpose_versions v ON v.purpose_id = p.id
        WHERE p.id = $1
        ORDER BY v.version_number DESC
        LIMIT 1`,
      [purposeId],
    );
    return rows[0] ?? null;
  }

  /**
   * Validate an ingest's targets in ONE query, on the hot path (FR-CON-03 sits
   * in checkout flows). `app.consent_append` re-checks the notice/purpose link
   * itself — that check is the guarantee — but doing it here too turns a raw
   * 23503 into a 404/400 that says which thing was wrong.
   */
  ingestTargets(
    client: PoolClient,
    purposeId: string,
    noticeVersionId: string,
  ): Promise<ConsentIngestTargets | null> {
    return client
      .query<ConsentIngestTargets>(
        `SELECT v.purpose_name         AS "purposeName",
                p.status               AS "purposeStatus",
                EXISTS (
                  SELECT 1 FROM consent_notice_versions nv
                   WHERE nv.id = $2 AND nv.purpose_id = p.id
                )                      AS "noticeBelongsToPurpose"
           FROM consent_purposes p
           JOIN consent_purpose_versions v ON v.purpose_id = p.id
          WHERE p.id = $1
          ORDER BY v.version_number DESC
          LIMIT 1`,
        [purposeId, noticeVersionId],
      )
      .then(({ rows }) => rows[0] ?? null);
  }

  // --- event reads (FR-CON-08 proof-of-consent) -----------------------------

  /**
   * A subject's event history, newest first by valid-time.
   *
   * Optionally bitemporal: `asOf` bounds valid-time and `knownAs` bounds
   * transaction-time, so the same query answers both "what happened by then"
   * and "…as far as we knew then". Passing null for both returns everything.
   */
  history(
    subjectRef: string,
    purposeId: string | null,
    limit: number,
    asOf: string | null = null,
    knownAs: string | null = null,
  ): Promise<ConsentEventRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentEventRow>(
        `SELECT e.id, e.subject_ref, e.purpose_id, latest_purpose.name AS purpose_name, e.status,
                e.notice_version_id, e.legacy_notice_version_ref,
                e.occurred_at, e.recorded_at, e.source, e.evidence_hash, e.evidence_hash_origin
           FROM consent_events e
           LEFT JOIN LATERAL (
             SELECT v.purpose_name AS name
               FROM consent_purpose_versions v
              WHERE v.purpose_id = e.purpose_id
              ORDER BY v.version_number DESC
              LIMIT 1
           ) latest_purpose ON true
          WHERE e.subject_ref = $1
            AND ($2::uuid IS NULL OR e.purpose_id = $2)
            AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
            AND ($5::timestamptz IS NULL OR e.recorded_at <= $5)
          ORDER BY e.occurred_at DESC, e.recorded_at DESC
          LIMIT $3`,
        [subjectRef, purposeId, limit, asOf, knownAs],
      );
      return rows;
    });
  }

  /**
   * The subject's derived consent status per purpose at a point in BOTH clocks
   * (FR-CON-05) — the query that answers "what was true on 3rd March, as far as
   * we knew on 3rd March?".
   *
   * Note there is no stored status to read: the answer is computed from the
   * append-only log every time. That is exactly why the question remains
   * answerable forever, and why a mutable `status` column could never answer
   * it — a withdrawal overwrote the grant, and with it the past.
   */
  statusAsOf(subjectRef: string, asOf: string, knownAs: string): Promise<ConsentEventRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentEventRow>(
        `SELECT DISTINCT ON (e.purpose_id)
                e.id, e.subject_ref, e.purpose_id, latest_purpose.name AS purpose_name, e.status,
                e.notice_version_id, e.legacy_notice_version_ref,
                e.occurred_at, e.recorded_at, e.source, e.evidence_hash, e.evidence_hash_origin
           FROM consent_events e
           LEFT JOIN LATERAL (
             SELECT v.purpose_name AS name
               FROM consent_purpose_versions v
              WHERE v.purpose_id = e.purpose_id
              ORDER BY v.version_number DESC
              LIMIT 1
           ) latest_purpose ON true
          WHERE e.subject_ref = $1
            AND e.occurred_at <= $2
            AND e.recorded_at <= $3
          ORDER BY e.purpose_id, e.occurred_at DESC, e.recorded_at DESC`,
        [subjectRef, asOf, knownAs],
      );
      return rows;
    });
  }

  /**
   * The subject's CURRENT consent per purpose: the latest event for each purpose
   * by valid-time. Because the store is append-only, "current" is a query, never
   * a mutable column — which is exactly what lets the same data also answer "what
   * was true on 3rd March?" (add an `occurred_at <= $2` filter). FR-CON-05.
   */
  currentStatus(subjectRef: string): Promise<ConsentEventRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentEventRow>(
        `SELECT DISTINCT ON (e.purpose_id)
                e.id, e.subject_ref, e.purpose_id, latest_purpose.name AS purpose_name, e.status,
                e.notice_version_id, e.legacy_notice_version_ref,
                e.occurred_at, e.recorded_at, e.source, e.evidence_hash, e.evidence_hash_origin
           FROM consent_events e
           LEFT JOIN LATERAL (
             SELECT v.purpose_name AS name
               FROM consent_purpose_versions v
              WHERE v.purpose_id = e.purpose_id
              ORDER BY v.version_number DESC
              LIMIT 1
           ) latest_purpose ON true
          WHERE e.subject_ref = $1
          ORDER BY e.purpose_id, e.occurred_at DESC, e.recorded_at DESC`,
        [subjectRef],
      );
      return rows;
    });
  }

  /**
   * How many (subject, purpose) pairs are CURRENTLY granted, across every
   * subject — the "active consents" counter on the compliance dashboard
   * (FR-DSH-01). Same "latest event per pair" logic as currentStatus(), just
   * not scoped to one subject_ref, and reduced to a count rather than rows.
   */
  countActiveConsents(): Promise<number> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM (
             SELECT DISTINCT ON (e.subject_ref, e.purpose_id) e.status
               FROM consent_events e
              ORDER BY e.subject_ref, e.purpose_id, e.occurred_at DESC, e.recorded_at DESC
           ) latest
          WHERE latest.status = 'GRANTED'`,
      );
      return Number(rows[0]?.count ?? 0);
    });
  }
}
