import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface FulfilmentRow {
  id: string;
  ticket_id: string;
  kind: 'data_values' | 'correction' | 'erasure' | 'portability';
  status: 'pending' | 'confirmed' | 'declined' | 'failed';
  request_signature: string;
  request_payload_sha256: string;
  response_kind: 'link' | 'relay' | 'confirmation' | null;
  response_status_code: number | null;
  delivery_url_sha256: string | null;
  relayed_bytes: number | null;
  requested_at: Date;
  confirmed_at: Date | null;
  failure_reason: string | null;
}

/**
 * `dpr_fulfilments` — the evidence trail for Tier 2 and the fulfilment
 * webhooks (FR-DPR-05/07).
 *
 * ===========================================================================
 * READ THE METHOD SIGNATURES AS THE INVARIANT.
 *
 * Not one function in this file accepts a response body, a document, a value,
 * or a URL. `complete()` takes a HASH of the delivery URL and a BYTE COUNT for
 * a relay, and there is deliberately no overload that takes the thing itself.
 * If a future change needs to persist what the client returned, it cannot do it
 * through this repository without adding a parameter — which is exactly the
 * moment someone should stop and re-read the migration's header.
 *
 * Contrast `WebhookDeliveriesRepository`, which stores its `payload` quite
 * happily. That is correct there and would be catastrophic here: a
 * consent-change notification contains a subject ref and a purpose id; a Tier 2
 * response contains the person's actual data.
 * ===========================================================================
 */
@Injectable()
export class FulfilmentRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Opened BEFORE the outbound call, so a request that is made is recorded
   *  even if the process dies mid-flight. A fulfilment that left the building
   *  and vanished from the trail is the one failure mode worth preventing. */
  async open(input: {
    ticketId: string;
    kind: FulfilmentRow['kind'];
    requestSignature: string;
    requestPayloadSha256: string;
    requestedBy: string | null;
  }): Promise<FulfilmentRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<FulfilmentRow>(
        `INSERT INTO dpr_fulfilments
           (ticket_id, kind, request_signature, request_payload_sha256, requested_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.ticketId,
          input.kind,
          input.requestSignature,
          input.requestPayloadSha256,
          input.requestedBy,
        ],
      );
      return rows[0]!;
    });
  }

  /**
   * Record the outcome. Note every parameter: a status, a code, two hashes, a
   * count, and a failure string. Nothing here can carry content.
   *
   * `failureReason` is the one free-text field, and it is the one place a
   * careless change could leak: an error handler that stringified the client's
   * response body into it would put customer data in the database through a
   * column called `failure_reason`. The caller is responsible for passing only
   * transport-level errors, and `FulfilmentService.describeFailure` is the only
   * thing that constructs this value — see its comment.
   */
  async complete(
    fulfilmentId: string,
    input: {
      status: FulfilmentRow['status'];
      responseKind: FulfilmentRow['response_kind'];
      responseStatusCode: number | null;
      deliveryUrlSha256: string | null;
      linkExpiresAt: Date | null;
      relayedBytes: number | null;
      failureReason: string | null;
    },
  ): Promise<void> {
    await this.db.withTenant(async (client) => {
      await client.query(
        `UPDATE dpr_fulfilments
            SET status = $2, response_kind = $3, response_status_code = $4,
                delivery_url_sha256 = $5, link_expires_at = $6, relayed_bytes = $7,
                failure_reason = $8,
                confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END
          WHERE id = $1`,
        [
          fulfilmentId,
          input.status,
          input.responseKind,
          input.responseStatusCode,
          input.deliveryUrlSha256,
          input.linkExpiresAt?.toISOString() ?? null,
          input.relayedBytes,
          input.failureReason,
        ],
      );
    });
  }

  listForTicket(ticketId: string): Promise<FulfilmentRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<FulfilmentRow>(
        `SELECT * FROM dpr_fulfilments WHERE ticket_id = $1 ORDER BY requested_at DESC`,
        [ticketId],
      );
      return rows;
    });
  }
}
