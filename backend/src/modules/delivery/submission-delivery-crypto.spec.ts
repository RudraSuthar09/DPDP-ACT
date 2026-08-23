import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SubmissionDeliveryCipher } from './submission-delivery-crypto';

function configWith(value: string | undefined): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

const KEY = randomBytes(32).toString('base64');

describe('SubmissionDeliveryCipher', () => {
  const cipher = new SubmissionDeliveryCipher(configWith(KEY));
  const aad = 'submission-id-a';

  it('round-trips a staged payload (field values + a document)', () => {
    const plaintext = Buffer.from(JSON.stringify({ fields: [{ label: 'Aadhaar', textValue: '1234-5678-9012' }] }), 'utf8');
    const { ciphertext, iv, authTag } = cipher.encrypt(plaintext, aad);
    expect(cipher.decrypt(ciphertext, iv, authTag, aad).equals(plaintext)).toBe(true);
  });

  it('never leaves the plaintext value recognisable in the ciphertext', () => {
    const plaintext = Buffer.from('AADHAAR-1234-5678-9012', 'utf8');
    const { ciphertext } = cipher.encrypt(plaintext, aad);
    expect(ciphertext.includes(plaintext)).toBe(false);
  });

  it('uses a fresh IV every time — the same plaintext encrypts differently', () => {
    const plaintext = randomBytes(64);
    const a = cipher.encrypt(plaintext, aad);
    const b = cipher.encrypt(plaintext, aad);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a ciphertext decrypted under the WRONG aad — a ciphertext lifted from one delivery row cannot decrypt in another', () => {
    const plaintext = randomBytes(32);
    const { ciphertext, iv, authTag } = cipher.encrypt(plaintext, 'submission-id-a');
    expect(() => cipher.decrypt(ciphertext, iv, authTag, 'submission-id-b')).toThrow();
  });

  it('rejects a tampered ciphertext (authenticity, not just confidentiality)', () => {
    const plaintext = randomBytes(32);
    const { ciphertext, iv, authTag } = cipher.encrypt(plaintext, aad);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => cipher.decrypt(ciphertext, iv, authTag, aad)).toThrow();
  });

  it('requires exactly a 32-byte base64 key', () => {
    expect(() => new SubmissionDeliveryCipher(configWith(randomBytes(16).toString('base64')))).toThrow(/32 bytes/);
    expect(() => new SubmissionDeliveryCipher(configWith(undefined))).toThrow(/required/);
  });
});
