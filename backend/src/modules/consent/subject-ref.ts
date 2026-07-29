import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { TenantConsentSecretsRepository } from './tenant-consent-secrets.repository';

/**
 * Subject-reference pseudonymisation (FR-CON-04, invariant I2).
 *
 * The client's internal customer id must NEVER be stored on the platform. What
 * we store is an HMAC of it — and the direction matters: HMAC is one-way, so
 * from a stored `subject_ref` the platform cannot recover the customer id,
 * while the client, who holds the id, can re-derive the same ref to look up
 * their own events. That asymmetry is the whole of I2.
 *
 *   subjectRef = HMAC-SHA256(tenantSecret, customerId)
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECRET IS STORED PER TENANT, not derived from one deployment pepper
 *
 * This used to compute `tenantKey = HMAC(SUBJECT_REF_HMAC_PEPPER, tenantId)` —
 * per-tenant in effect, but with all tenants' keys reproducible from a single
 * environment variable. Three things were wrong with that, and none of them is
 * visible until it matters:
 *
 *   * One leaked pepper reproduces EVERY tenant's subject refs, not one's.
 *   * Rotating it invalidates every tenant's references simultaneously — there
 *     is no way to rotate one compromised tenant.
 *   * The master doc says "HMAC'd with a per-tenant secret", and Stage 2 wants
 *     per-tenant keys in KMS/Vault (NFR-SEC-02). Real per-tenant secret
 *     material now makes that a key-STORAGE change; derived keys would have
 *     made it a re-hash of every consent event ever written, which is to say
 *     impossible.
 *
 * The secrets themselves live in `tenant_consent_secrets`, encrypted at rest —
 * see TenantConsentSecretsRepository for the hot-path and transaction reasoning.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class SubjectRefHasher {
  constructor(private readonly secrets: TenantConsentSecretsRepository) {}

  /** The opaque, per-tenant, irreversible reference stored on every consent event. */
  async hash(tenantId: string, customerId: string): Promise<string> {
    const secret = await this.secrets.getOrCreate(tenantId);
    return createHmac('sha256', secret).update(customerId.trim()).digest('hex');
  }
}
