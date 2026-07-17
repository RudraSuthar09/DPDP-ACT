import {
  hotp,
  totp,
  totpStep,
  TOTP_STEP_SECONDS,
  generateTotpSecret,
  totpAuthUri,
  verifyTotp,
} from './totp';
import { base32Decode, base32Encode } from './base32';

/**
 * The point of these tests: a hand-rolled implementation of a cryptographic
 * standard is only defensible if it is checked against the standard's OWN
 * published vectors. RFC 4226 and RFC 6238 both ship test vectors precisely so
 * that implementations can prove themselves. If these pass, this file computes
 * the same codes as every authenticator app on earth.
 */

describe('HOTP — RFC 4226 Appendix D test vectors', () => {
  // The RFC's secret: the ASCII string "12345678901234567890".
  const secret = Buffer.from('12345678901234567890', 'ascii');

  // Table 1 of RFC 4226 Appendix D, verbatim.
  const vectors: [counter: number, expected: string][] = [
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ];

  it.each(vectors)('counter %i → %s', (counter, expected) => {
    expect(hotp(secret, counter)).toBe(expected);
  });
});

describe('TOTP — RFC 6238 Appendix B test vectors', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');

  // RFC 6238 Appendix B, the SHA-1 rows. The RFC prints 8-digit codes; we take
  // the low 6, which is what every authenticator app displays.
  const vectors: [unixSeconds: number, eightDigits: string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('T=%i → %s', (unixSeconds, eightDigits) => {
    const counter = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
    expect(hotp(secret, counter, 8)).toBe(eightDigits);
    // And the 6-digit code the product actually uses is its last six digits.
    expect(totp(secret, unixSeconds * 1000)).toBe(eightDigits.slice(-6));
  });

  it('handles a counter beyond 2^53 without losing precision', () => {
    // Guards the BigInt write in hotp(): a Number-based shift silently corrupts
    // here, and the failure would only appear ~285 million years from now — or
    // immediately, for anyone whose clock is badly wrong.
    expect(() => hotp(secret, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    expect(verifyTotp(secret, totp(secret, now), { atMs: now })).toMatchObject({ valid: true });
  });

  it('accepts a code one step old (clock drift tolerance)', () => {
    const previous = totp(secret, now - TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, previous, { atMs: now }).valid).toBe(true);
  });

  it('accepts a code one step early (clock drift tolerance)', () => {
    const next = totp(secret, now + TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, next, { atMs: now }).valid).toBe(true);
  });

  it('rejects a code two steps old (outside the window)', () => {
    const stale = totp(secret, now - 2 * TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, stale, { atMs: now }).valid).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    expect(verifyTotp(secret, totp(generateTotpSecret(), now), { atMs: now }).valid).toBe(false);
  });

  it.each([['12345'], ['1234567'], ['abcdef'], [''], ['12 34 56']])(
    'rejects malformed input %p',
    (input) => {
      expect(verifyTotp(secret, input, { atMs: now }).valid).toBe(false);
    },
  );

  it('reports the step it matched, so the caller can burn it', () => {
    const result = verifyTotp(secret, totp(secret, now), { atMs: now });
    expect(result.step).toBe(totpStep(now));
  });

  // The replay defence (RFC 6238 §5.2). Without it a code stays valid for its
  // whole window — enough for anyone who read it over a shoulder to reuse it.
  it('rejects a code whose step was already consumed', () => {
    const code = totp(secret, now);
    const first = verifyTotp(secret, code, { atMs: now });
    expect(first.valid).toBe(true);

    const replay = verifyTotp(secret, code, { atMs: now, lastUsedStep: first.step });
    expect(replay.valid).toBe(false);
  });

  it('rejects a still-in-window OLD code once a newer step has been consumed', () => {
    // The subtle case: user authenticates at step N, then an attacker replays
    // the step N-1 code, which is arithmetically still inside the window.
    const oldCode = totp(secret, now - TOTP_STEP_SECONDS * 1000);
    const result = verifyTotp(secret, oldCode, { atMs: now, lastUsedStep: totpStep(now) });
    expect(result.valid).toBe(false);
  });
});

describe('base32 (RFC 4648)', () => {
  // RFC 4648 §10 test vectors.
  const vectors: [input: string, encoded: string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(vectors)('encodes %p → %p', (input, encoded) => {
    expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(encoded);
  });

  it.each(vectors)('decodes %p ← %p', (input, encoded) => {
    expect(base32Decode(encoded).toString('ascii')).toBe(input);
  });

  it('round-trips a real TOTP secret', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('tolerates the lowercase, padding, and spaces users actually paste', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString('ascii')).toBe('foobar');
  });
});

describe('totpAuthUri', () => {
  const secret = generateTotpSecret();

  it('is a scannable otpauth URI carrying the secret and issuer', () => {
    const uri = totpAuthUri({ secret, account: 'dpo@acme.example', issuer: 'DPDP Platform' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${base32Encode(secret)}`);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('escapes the label so an email with a + or a space cannot break the URI', () => {
    const uri = totpAuthUri({ secret, account: 'a+b c@acme.example', issuer: 'DPDP Platform' });
    expect(uri).toContain('otpauth://totp/DPDP%20Platform%3Aa%2Bb%20c%40acme.example');
  });
});
