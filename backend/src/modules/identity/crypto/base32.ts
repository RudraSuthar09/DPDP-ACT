/**
 * RFC 4648 base32 — the encoding every authenticator app expects for a TOTP
 * secret (in the `otpauth://` URI and in the "type it in manually" fallback).
 *
 * Hand-rolled rather than pulled from a dependency: it is ~40 lines of pure bit
 * shuffling with a published spec and published test vectors, and a credential
 * encoder is a poor place to take on an unaudited transitive dependency tree.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes as base32. Unpadded — authenticator apps neither need nor want `=`. */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    // Shift the new byte in at the bottom and drain 5 bits at a time from the top.
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // Left-align whatever is left over into a final 5-bit group.
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decode base32 back to bytes. Tolerates lowercase, padding, and the spaces
 * authenticator apps like to show — users paste what they see.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  // Any remaining <8 bits are the encoder's zero padding — correctly discarded.
  return Buffer.from(bytes);
}
