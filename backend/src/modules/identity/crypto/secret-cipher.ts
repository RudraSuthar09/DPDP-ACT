import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Field-level encryption for secrets at rest (NFR-SEC-03).
 *
 * The only thing behind this today is the TOTP shared secret — which is a
 * bearer credential: anyone holding it can generate valid codes forever, so a
 * dump of the users table must not be enough to defeat MFA for the whole
 * platform.
 *
 * The interface is the seam for NFR-SEC-02 ("per-tenant data keys wrapped by a
 * KMS master key"). Stage 1 uses one key from the environment; a KMS-backed
 * implementation slides in behind this with no caller changes, and the `v1$`
 * version prefix on every ciphertext is what makes that migration decryptable.
 */
export interface SecretCipher {
  /**
   * `aad` is additional authenticated data: not encrypted, but bound into the
   * authentication tag, so ciphertext lifted from one row will not decrypt in
   * another. Callers pass the tenant + user it belongs to.
   */
  encrypt(plaintext: Buffer, aad: string): string;
  decrypt(ciphertext: string, aad: string): Buffer;
}

export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

/** AES-256-GCM. Authenticated, so tampering fails loudly rather than silently. */
@Injectable()
export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const configured = config.get<string>('MFA_SECRET_ENC_KEY');
    if (!configured) {
      throw new Error(
        'MFA_SECRET_ENC_KEY is required — TOTP secrets are never stored in plaintext ' +
          '(NFR-SEC-03). Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    this.key = Buffer.from(configured, 'base64');
    if (this.key.length !== 32) {
      throw new Error(
        `MFA_SECRET_ENC_KEY must be exactly 32 bytes (base64-encoded) for AES-256; got ${this.key.length}.`,
      );
    }
  }

  encrypt(plaintext: Buffer, aad: string): string {
    // A fresh 96-bit IV per encryption. GCM catastrophically loses
    // confidentiality AND authenticity on IV reuse under the same key, so this
    // is random per call and never derived from anything.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('$');
  }

  decrypt(ciphertext: string, aad: string): Buffer {
    const parts = ciphertext.split('$');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Unrecognised secret ciphertext format.');
    }
    const [, iv, tag, payload] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    // Throws on a tag mismatch — i.e. tampering, a wrong key, or a ciphertext
    // moved between users. That is the desired behaviour: fail, never guess.
    decipher.setAuthTag(Buffer.from(tag!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload!, 'base64')), decipher.final()]);
  }
}
