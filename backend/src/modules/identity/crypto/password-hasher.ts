import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// scrypt is overloaded (with and without an options argument) and promisify
// resolves to the first overload, which has no options — so the cost parameters
// below would be silently dropped back to Node's defaults. Pin the signature we
// actually want.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * The password hashing contract (FR-IDN-02). Everything that stores or checks a
 * password goes through this interface, so the algorithm is a one-line swap and
 * never a code change in the auth flow.
 */
export interface PasswordHasher {
  /** Hash a plaintext password into a self-describing encoded string. */
  hash(password: string): Promise<string>;
  /** Verify a plaintext password against an encoded hash. Never throws on bad input. */
  verify(password: string, encoded: string): Promise<boolean>;
  /** True if `encoded` was produced with parameters weaker than current policy. */
  needsRehash(encoded: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/**
 * scrypt (RFC 7914) via node:crypto.
 *
 * Why scrypt and not Argon2id: Argon2id is the better primitive and OWASP's
 * first choice — but every Node binding for it is a native module, which means a
 * compiler in the Docker build and a class of install failures on developer
 * machines. scrypt is memory-hard, it is in the standard library with zero
 * dependencies, and OWASP lists it as an acceptable choice at these parameters.
 * The interface above is the escape hatch: when Argon2id is worth the native
 * dependency, implement `PasswordHasher` again, and `password_algo` on the users
 * row lets existing hashes migrate lazily on next successful login.
 *
 * Encoded format — self-describing, so a parameter change never invalidates old
 * hashes: `scrypt$N$r$p$<salt-b64>$<hash-b64>`
 */
export class ScryptPasswordHasher implements PasswordHasher {
  // OWASP's minimum for scrypt is N=2^17,r=8,p=1; N=2^15 with r=8 is the widely
  // used interactive-login setting (~32 MiB, ~100 ms) and is what a login
  // endpoint can afford per request without becoming its own DoS vector.
  private readonly cost = 2 ** 15;
  private readonly blockSize = 8;
  private readonly parallelism = 1;
  private readonly keyLength = 64;

  // scrypt needs ~128 * N * r bytes; Node's default maxmem (32 MiB) is a hair
  // under what N=2^15,r=8 wants, and it throws rather than degrading. Be explicit.
  private readonly maxmem = 128 * this.cost * this.blockSize * 2;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await this.derive(password, salt, this.cost, this.blockSize, this.parallelism);
    return [
      'scrypt',
      this.cost,
      this.blockSize,
      this.parallelism,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = this.parse(encoded);
    if (!parsed) {
      return false;
    }
    const { cost, blockSize, parallelism, salt, expected } = parsed;
    try {
      const actual = await this.derive(
        password,
        salt,
        cost,
        blockSize,
        parallelism,
        expected.length,
      );
      // Constant-time: a byte-at-a-time comparison leaks the hash prefix.
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      // Malformed stored hash — a failed verification, not an exception that
      // could hand an attacker a distinguishable 500.
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    const parsed = this.parse(encoded);
    if (!parsed) {
      return true;
    }
    return (
      parsed.cost < this.cost ||
      parsed.blockSize < this.blockSize ||
      parsed.parallelism !== this.parallelism
    );
  }

  private derive(
    password: string,
    salt: Buffer,
    cost: number,
    blockSize: number,
    parallelism: number,
    keyLength: number = this.keyLength,
  ): Promise<Buffer> {
    // Normalise to NFC so a password typed with a combining accent on one OS
    // still matches the same password typed with a precomposed one on another.
    return scryptAsync(password.normalize('NFC'), salt, keyLength, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: this.maxmem,
    });
  }

  private parse(encoded: string): {
    cost: number;
    blockSize: number;
    parallelism: number;
    salt: Buffer;
    expected: Buffer;
  } | null {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return null;
    }
    const [, cost, blockSize, parallelism, salt, hash] = parts;
    const parsed = {
      cost: Number(cost),
      blockSize: Number(blockSize),
      parallelism: Number(parallelism),
      salt: Buffer.from(salt!, 'base64'),
      expected: Buffer.from(hash!, 'base64'),
    };
    if (!Number.isInteger(parsed.cost) || parsed.cost < 2 || !parsed.expected.length) {
      return null;
    }
    return parsed;
  }
}

/**
 * A hash of a random throwaway password, computed once at startup.
 *
 * Login verifies against this when the email is unknown, so that "no such user"
 * costs the same ~100 ms as "wrong password". Without it, response time answers
 * "does this address have an account here?" for anyone with a stopwatch — which
 * on a DPDP compliance platform is itself a disclosure about the client's staff.
 */
export async function makeDummyHash(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomBytes(32).toString('hex'));
}
