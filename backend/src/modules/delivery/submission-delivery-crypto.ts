import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Encryption for the submission-delivery staging payload (see
 * submission-delivery.service.ts's header for what this table is and why it
 * exists at all — a documented, narrow CLAUDE.md I1/R6 exception).
 *
 * Deliberately its OWN key (SUBMISSION_STAGING_ENC_KEY), separate from
 * MFA_SECRET_ENC_KEY (identity/crypto/secret-cipher.ts) — a compromise of one
 * key must not also expose the other. Same AES-256-GCM shape/discipline as
 * that cipher, just for a different, larger (and larger-volume, since it
 * includes document bytes) kind of secret.
 */
@Injectable()
export class SubmissionDeliveryCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const configured = config.get<string>('SUBMISSION_STAGING_ENC_KEY');
    if (!configured) {
      throw new Error(
        'SUBMISSION_STAGING_ENC_KEY is required — staged submission field values/documents are ' +
          'never held in plaintext (CLAUDE.md I1/R6 exception). Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    this.key = Buffer.from(configured, 'base64');
    if (this.key.length !== 32) {
      throw new Error(
        `SUBMISSION_STAGING_ENC_KEY must be exactly 32 bytes (base64-encoded) for AES-256; got ${this.key.length}.`,
      );
    }
  }

  /** `aad` binds the ciphertext to the row it belongs to (the delivery id) so
   *  a ciphertext moved between rows fails to decrypt rather than silently
   *  decrypting into the wrong submission. */
  encrypt(plaintext: Buffer, aad: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer, aad: string): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
