import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Subject-reference pseudonymisation (FR-CON-04, invariant I2).
 *
 * The client's internal customer id must NEVER be stored on the platform. What we
 * store is an HMAC of it — and the direction matters: HMAC is one-way, so from a
 * stored `subject_ref` the platform cannot recover the customer id, while the
 * client, who holds the id, can re-derive the same ref to look up their own
 * events. That asymmetry is the whole of I2.
 *
 * Two levels, on purpose:
 *
 *   tenantKey  = HMAC(pepper, tenantId)
 *   subjectRef = HMAC(tenantKey, customerId)
 *
 * The per-tenant derived key means a `subject_ref` is meaningless outside its
 * tenant (the same customer id in two tenants hashes to two unrelated refs), and
 * that the refs of one tenant cannot be reproduced without that tenant's derived
 * key. The pepper is a single deployment secret today; per-tenant secrets in KMS
 * are the Stage-2+ story, and this two-level shape is already what makes that a
 * key-storage change rather than a re-hash of every event ever written.
 */
@Injectable()
export class SubjectRefHasher {
  private readonly pepper: Buffer;

  constructor(config: ConfigService) {
    const pepper = config.get<string>('SUBJECT_REF_HMAC_PEPPER');
    if (!pepper || pepper.length < 16) {
      throw new Error(
        'SUBJECT_REF_HMAC_PEPPER is required (>= 16 chars) for subject pseudonymisation ' +
          '(FR-CON-04 / I2). Without it, a customer id could reach the database in the clear.',
      );
    }
    this.pepper = Buffer.from(pepper, 'utf8');
  }

  /** The opaque, per-tenant, irreversible reference stored on every consent event. */
  hash(tenantId: string, customerId: string): string {
    const tenantKey = createHmac('sha256', this.pepper).update(tenantId).digest();
    return createHmac('sha256', tenantKey).update(customerId.trim()).digest('hex');
  }
}
