import { ScryptPasswordHasher, makeDummyHash } from './password-hasher';

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  // scrypt at interactive parameters is ~100ms by design; a handful of hashes
  // per test comfortably exceeds Jest's 5s default.
  jest.setTimeout(30_000);

  it('verifies a correct password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', encoded)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('Correct horse battery staple', encoded)).resolves.toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')]);
    // Without a per-hash salt, identical passwords produce identical hashes and
    // a table dump reveals which users share one.
    expect(a).not.toBe(b);
    await expect(hasher.verify('same password', a)).resolves.toBe(true);
    await expect(hasher.verify('same password', b)).resolves.toBe(true);
  });

  it('never stores the password in the encoded output', async () => {
    const encoded = await hasher.hash('sup3r-s3cret-passphrase');
    expect(encoded).not.toContain('sup3r-s3cret-passphrase');
  });

  it('encodes its parameters, so they can change without invalidating old hashes', async () => {
    const encoded = await hasher.hash('whatever you like');
    const [algo, cost, blockSize, parallelism, salt, hash] = encoded.split('$');
    expect(algo).toBe('scrypt');
    expect(Number(cost)).toBeGreaterThanOrEqual(2 ** 15);
    expect(Number(blockSize)).toBe(8);
    expect(Number(parallelism)).toBe(1);
    expect(salt!.length).toBeGreaterThan(0);
    expect(hash!.length).toBeGreaterThan(0);
  });

  it('flags a hash made with weaker parameters for rehash', () => {
    // The lazy-migration trigger: when policy strengthens, this is what tells
    // the login path to re-hash the password it has just been handed in plaintext
    // — the only moment we ever hold it.
    expect(hasher.needsRehash('scrypt$4096$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('does not flag a current-policy hash for rehash', async () => {
    expect(hasher.needsRehash(await hasher.hash('current policy password'))).toBe(false);
  });

  it.each([
    ['not a hash at all'],
    [''],
    ['scrypt$'],
    ['scrypt$1$2$3$4'],
    ['argon2$32768$8$1$c2FsdA==$aGFzaA=='],
    ['scrypt$notanumber$8$1$c2FsdA==$aGFzaA=='],
  ])('returns false (never throws) for malformed stored hash %p', async (encoded) => {
    // A malformed hash must be a failed login, not a 500 — an exception here is
    // both an availability bug and a distinguishable response for an attacker.
    await expect(hasher.verify('anything', encoded)).resolves.toBe(false);
  });

  it('treats unicode-equivalent passwords as equal (NFC normalisation)', async () => {
    // é as one codepoint vs e + combining accent: the same password to the user,
    // and typed differently by macOS and Windows.
    // Written as escapes, not literal characters: an editor or a git filter
    // that silently normalises this file would otherwise make the test vacuous.
    const composed = 'café-password-2026'; // e-acute as ONE codepoint
    const decomposed = 'café-password-2026'; // 'e' + combining acute
    expect(composed).not.toBe(decomposed);
    const encoded = await hasher.hash(composed);
    await expect(hasher.verify(decomposed, encoded)).resolves.toBe(true);
  });

  it('handles a long password without exploding (the KDF-DoS bound is in the DTO)', async () => {
    const long = 'x'.repeat(256);
    await expect(hasher.verify(long, await hasher.hash(long))).resolves.toBe(true);
  });

  it('makeDummyHash produces a verifiable hash nobody knows the password to', async () => {
    const dummy = await makeDummyHash(hasher);
    await expect(hasher.verify('guess', dummy)).resolves.toBe(false);
    expect(dummy.startsWith('scrypt$')).toBe(true);
  });
});
