import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';
import { SECRET_CIPHER, type SecretCipher } from '../identity/crypto/secret-cipher';

/** Bound into the AES-GCM authentication tag, so a secret's ciphertext lifted
 *  into another tenant's row fails to decrypt rather than silently working. */
function aadFor(tenantId: string): string {
  return `consent-subject-ref:${tenantId}`;
}

/**
 * The per-tenant subject-reference HMAC secret (FR-CON-04, I2).
 *
 * 32 random bytes per tenant, encrypted at rest with the same SecretCipher that
 * protects TOTP secrets. Random and independent per tenant — NOT derived from a
 * shared deployment pepper — so one tenant's secret tells you nothing about
 * another's, and a compromise or rotation is contained to one tenant instead of
 * invalidating every subject reference on the platform at once.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS HERE ARE LOAD-BEARING FOR THE INGEST HOT PATH (FR-CON-03 sits in
 * clients' checkout flows), and both are easy to break by "simplifying":
 *
 *   1. The in-process cache. Without it every ingest costs an extra round trip
 *      and a decrypt. With it, the secret is fetched once per tenant per process.
 *      The cache is safe because the row is immutable — dpdp_app holds no UPDATE
 *      grant on this table (see the migration), so a cached value cannot go
 *      stale. If rotation is ever added, it MUST invalidate this cache.
 *
 *   2. `withTenantIdDetached`. Creating the secret runs in its OWN transaction,
 *      not the request's unit of work. If it joined the request transaction and
 *      that request later failed, the audit interceptor would roll the secret
 *      back — but we would already have cached it and hashed a subject under it.
 *      Every later event for that tenant would then be stored under a secret
 *      that exists nowhere, and no client could ever re-derive those refs. The
 *      secret is tenant configuration, not event data; it must become true
 *      independently of any one event, which is exactly what that method is for.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class TenantConsentSecretsRepository {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly db: TenantDatabaseService,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
  ) {}

  /** The tenant's secret, creating it on first use. Cached per process. */
  async getOrCreate(tenantId: string): Promise<Buffer> {
    const cached = this.cache.get(tenantId);
    if (cached) {
      return cached;
    }

    const secret = await this.db.withTenantIdDetached(tenantId, async (client) => {
      const existing = await client.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM tenant_consent_secrets WHERE tenant_id = $1',
        [tenantId],
      );
      if (existing.rows[0]) {
        return this.cipher.decrypt(existing.rows[0].secret_ciphertext, aadFor(tenantId));
      }

      const fresh = randomBytes(32);
      // ON CONFLICT DO NOTHING, then re-read: two concurrent first-ever ingests
      // for the same tenant must end up agreeing on ONE secret. Whichever loses
      // the race discards its bytes and adopts the winner's — if it kept its own,
      // that request's subject_ref would be unreproducible forever.
      const inserted = await client.query<{ secret_ciphertext: string }>(
        `INSERT INTO tenant_consent_secrets (tenant_id, secret_ciphertext)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING secret_ciphertext`,
        [tenantId, this.cipher.encrypt(fresh, aadFor(tenantId))],
      );
      if (inserted.rows[0]) {
        return fresh;
      }

      const winner = await client.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM tenant_consent_secrets WHERE tenant_id = $1',
        [tenantId],
      );
      return this.cipher.decrypt(winner.rows[0]!.secret_ciphertext, aadFor(tenantId));
    });

    this.cache.set(tenantId, secret);
    return secret;
  }
}
