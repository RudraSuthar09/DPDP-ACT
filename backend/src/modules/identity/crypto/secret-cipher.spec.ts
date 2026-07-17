import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { AesGcmSecretCipher } from './secret-cipher';

/** A ConfigService stand-in — this class reads exactly one key. */
function configWith(value: string | undefined): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

const KEY = randomBytes(32).toString('base64');

describe('AesGcmSecretCipher', () => {
  const cipher = new AesGcmSecretCipher(configWith(KEY));
  const aad = 'mfa:tenant-a:user-1';

  it('round-trips a TOTP secret', () => {
    const secret = randomBytes(20);
    expect(cipher.decrypt(cipher.encrypt(secret, aad), aad).equals(secret)).toBe(true);
  });

  it('never emits the plaintext', () => {
    const secret = Buffer.from('THE-SHARED-SECRET', 'ascii');
    const encrypted = cipher.encrypt(secret, aad);
    expect(encrypted).not.toContain('THE-SHARED-SECRET');
    expect(Buffer.from(encrypted).includes(secret)).toBe(false);
  });

  it('uses a fresh IV: the same plaintext encrypts differently every time', () => {
    const secret = randomBytes(20);
    // GCM loses BOTH confidentiality and authenticity if an IV repeats under one
    // key, so this is not a nice-to-have property.
    expect(cipher.encrypt(secret, aad)).not.toBe(cipher.encrypt(secret, aad));
  });

  it('carries a version prefix so a future KMS-backed format stays decryptable', () => {
    expect(cipher.encrypt(randomBytes(20), aad).startsWith('v1$')).toBe(true);
  });

  // The AAD binding is the interesting one: it is what stops a ciphertext being
  // lifted from one row into another.
  it('refuses to decrypt with a different user/tenant binding', () => {
    const encrypted = cipher.encrypt(randomBytes(20), 'mfa:tenant-a:user-1');
    expect(() => cipher.decrypt(encrypted, 'mfa:tenant-a:user-2')).toThrow();
    expect(() => cipher.decrypt(encrypted, 'mfa:tenant-b:user-1')).toThrow();
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const encrypted = cipher.encrypt(randomBytes(20), aad);
    const [version, iv, tag, payload] = encrypted.split('$');
    const flipped = Buffer.from(payload!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64')].join('$');
    expect(() => cipher.decrypt(tampered, aad)).toThrow();
  });

  it('refuses to decrypt with a tampered auth tag', () => {
    const encrypted = cipher.encrypt(randomBytes(20), aad);
    const [version, iv, , payload] = encrypted.split('$');
    const forged = [version, iv, randomBytes(16).toString('base64'), payload].join('$');
    expect(() => cipher.decrypt(forged, aad)).toThrow();
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = cipher.encrypt(randomBytes(20), aad);
    const other = new AesGcmSecretCipher(configWith(randomBytes(32).toString('base64')));
    expect(() => other.decrypt(encrypted, aad)).toThrow();
  });

  it.each([['not-versioned'], ['v2$a$b$c'], [''], ['v1$only$three']])(
    'rejects malformed ciphertext %p',
    (input) => {
      expect(() => cipher.decrypt(input, aad)).toThrow();
    },
  );

  // Fail at boot, not at the first enrolment: a missing/short key must not be
  // discovered by a user halfway through setting up MFA.
  it('refuses to construct without a key', () => {
    expect(() => new AesGcmSecretCipher(configWith(undefined))).toThrow(/MFA_SECRET_ENC_KEY/);
  });

  it('refuses to construct with a key that is not 32 bytes', () => {
    expect(() => new AesGcmSecretCipher(configWith(randomBytes(16).toString('base64')))).toThrow(
      /32 bytes/,
    );
  });
});
