import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { ConsentApiKeysRepository, type ConsentApiKeyRow } from './consent-api-keys.repository';

/** Recognisable prefix, not a secret boundary — the whole value is hashed. */
const KEY_PREFIX = 'pc_live_';
const KEY_ENTROPY_BYTES = 32;
/** How much of the raw key is kept in the clear (key_prefix) so staff can
 *  tell keys apart in a list without it being useful for authentication. */
const VISIBLE_PREFIX_LENGTH = 12;

function toResponse(row: ConsentApiKeyRow) {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * FR-CON-09: staff-facing lifecycle for Consent SDK public API keys. The raw
 * key exists in memory for exactly one response (create) and is never stored
 * — only its SHA-256 hash is, so even a database compromise cannot recover a
 * usable key. There is deliberately no "reveal" endpoint, unlike the webhook
 * signing secret (AES-GCM, reversible): this key only ever needs equality
 * checking (app.resolve_public_api_key), never decryption, so storing it
 * irreversibly is strictly more secure and no less useful.
 */
@Injectable()
export class ConsentApiKeysService {
  constructor(
    private readonly repo: ConsentApiKeysRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(label: string): Promise<ReturnType<typeof toResponse> & { key: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const raw = KEY_PREFIX + randomBytes(KEY_ENTROPY_BYTES).toString('base64url');
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const row = await this.repo.create({
      keyHash,
      keyPrefix: raw.slice(0, VISIBLE_PREFIX_LENGTH),
      label,
      createdBy: ctx.userId,
    });
    return { ...toResponse(row), key: raw };
  }

  async list(): Promise<ReturnType<typeof toResponse>[]> {
    const rows = await this.repo.list();
    return rows.map(toResponse);
  }

  async revoke(id: string): Promise<ReturnType<typeof toResponse>> {
    const row = await this.repo.revoke(id);
    if (!row) {
      throw new NotFoundException('API key not found, or already revoked.');
    }
    return toResponse(row);
  }
}
