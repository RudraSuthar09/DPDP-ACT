import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';
import { SECRET_CIPHER, type SecretCipher } from '../identity/crypto/secret-cipher';

/** Bound into the AES-GCM authentication tag, so a secret's ciphertext lifted
 *  into another tenant's row fails to decrypt rather than silently working. */
function aadFor(tenantId: string): string {
  return `webhook-signing:${tenantId}`;
}

/**
 * The per-tenant webhook-signing HMAC secret (FR-CON-07).
 *
 * Deliberately the same shape as TenantConsentSecretsRepository (consent's own
 * per-tenant HMAC secret): 32 random bytes, encrypted at rest with the same
 * SecretCipher, cached in-process once fetched (safe because dpdp_app holds no
 * UPDATE grant on the table — see the migration — so a cached value cannot go
 * stale), created lazily on first use via `getOrCreate`, and read back in the
 * clear via `reveal` so the client can copy it into their own verification
 * code once (analogous to showing a TOTP secret during MFA enrolment).
 *
 * `getOrCreate` runs detached from the request's unit of work for the same
 * reason the consent secret does: this is tenant configuration that must
 * become true independently of whichever request happened to trigger it, not
 * data that should roll back with an unrelated failure later in that request.
 */
@Injectable()
export class WebhookSecretsRepository {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly db: TenantDatabaseService,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
  ) {}

  async getOrCreate(tenantId: string): Promise<Buffer> {
    const cached = this.cache.get(tenantId);
    if (cached) {
      return cached;
    }

    const secret = await this.db.withTenantIdDetached(tenantId, async (client) => {
      const existing = await client.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM tenant_webhook_secrets WHERE tenant_id = $1',
        [tenantId],
      );
      if (existing.rows[0]) {
        return this.cipher.decrypt(existing.rows[0].secret_ciphertext, aadFor(tenantId));
      }

      const fresh = randomBytes(32);
      // Two concurrent first-ever configurations for the same tenant must
      // agree on ONE secret — whichever loses the race adopts the winner's.
      const inserted = await client.query<{ secret_ciphertext: string }>(
        `INSERT INTO tenant_webhook_secrets (tenant_id, secret_ciphertext)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING secret_ciphertext`,
        [tenantId, this.cipher.encrypt(fresh, aadFor(tenantId))],
      );
      if (inserted.rows[0]) {
        return fresh;
      }

      const winner = await client.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM tenant_webhook_secrets WHERE tenant_id = $1',
        [tenantId],
      );
      return this.cipher.decrypt(winner.rows[0]!.secret_ciphertext, aadFor(tenantId));
    });

    this.cache.set(tenantId, secret);
    return secret;
  }
}
