import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnv, parseTrustProxy, validateEnv } from './env.validation';
import { maskRecipient } from '../logging/redact';

/**
 * Startup environment validation. The behaviour that matters:
 *   - a missing or malformed setting stops the process with EVERY problem
 *     listed, and never prints a value;
 *   - development and CI accept the documented placeholders, exactly as before;
 *   - production refuses them;
 *   - the worker is not asked for secrets it never uses.
 */

const KEY = randomBytes(32).toString('base64');
const DB = 'postgresql://dpdp_app:s3cret-pw@db.internal:5432/dpdp';
const OWNER_DB = 'postgresql://dpdp_owner:0wner-pw@db.internal:5432/dpdp';

const good = (over: Record<string, string> = {}): Record<string, string> => ({
  APP_DATABASE_URL: DB,
  DATABASE_URL: OWNER_DB,
  JWT_SECRET: randomBytes(32).toString('hex'),
  MFA_SECRET_ENC_KEY: KEY,
  SUBMISSION_STAGING_ENC_KEY: randomBytes(32).toString('base64'),
  ...over,
});
const CERT_DIR = mkdtempSync(join(tmpdir(), 'dpdp-ca-'));
const CA_FILE = join(CERT_DIR, 'rds-global-bundle.pem');
writeFileSync(
  CA_FILE,
  ['-----BEGIN CERTIFICATE-----', 'MIIB', '-----END CERTIFICATE-----', ''].join('\n'),
);
const NOT_A_CERT = join(CERT_DIR, 'notes.txt');
writeFileSync(NOT_A_CERT, 'not a certificate');

/** A COMPLETE production configuration for AWS: durable evidence, a verified
 *  database connection, and pg-boss on its own least-privilege role. */
const prod = (over: Record<string, string> = {}) =>
  good({
    NODE_ENV: 'production',
    IMPORT_EVIDENCE_STORE: 's3',
    IMPORT_EVIDENCE_S3_BUCKET: 'dpdp-evidence-prod',
    DATABASE_SSL_CA_FILE: CA_FILE,
    PGBOSS_DATABASE_URL: 'postgresql://dpdp_jobs:j0bs-pw@db.internal:5432/dpdp',
    WEB_ORIGIN: 'https://app.example.com',
    POSTMARK_API_KEY: 'pm',
    POSTMARK_FROM_EMAIL: 'no-reply@example.com',
    MSG91_AUTH_KEY: 'm',
    MSG91_SENDER_ID: 'DPDPIN',
    ...over,
  });

/** What .env.example ships, verbatim — must keep working locally. */
const EXAMPLE = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://dpdp:dpdp_local_dev_only@localhost:5432/dpdp',
  APP_DATABASE_URL: 'postgresql://dpdp_app:dpdp_app_local_dev_only@localhost:5432/dpdp',
  JWT_SECRET: 'change_me_dev_jwt_secret',
  MFA_SECRET_ENC_KEY: 'Q2hhbmdlTWVEZXZPbmx5S2V5Rm9yTG9jYWxVc2UhISE=',
  SUBMISSION_STAGING_ENC_KEY: 'Q2hhbmdlTWVEZXZPbmx5S2V5Rm9yTG9jYWxVc2UhISE=',
  REQUEST_OTP_SECRET: 'change_me_dev_otp_secret',
  NOTIFY_TRANSPORT: 'console',
};

describe('what each process requires', () => {
  it('a complete API configuration passes with no errors', () => {
    expect(checkEnv(good(), 'api').errors).toEqual([]);
  });

  it('the API reports EVERY missing secret at once, not one per restart', () => {
    const { errors } = checkEnv({}, 'api');
    for (const k of [
      'APP_DATABASE_URL',
      'DATABASE_URL',
      'JWT_SECRET',
      'MFA_SECRET_ENC_KEY',
      'SUBMISSION_STAGING_ENC_KEY',
    ]) {
      expect(errors.some((e) => e.startsWith(`${k} is required`))).toBe(true);
    }
  });

  it('the WORKER is not asked for JWT_SECRET or the staging key, which it never loads', () => {
    expect(
      checkEnv({ APP_DATABASE_URL: DB, DATABASE_URL: OWNER_DB, MFA_SECRET_ENC_KEY: KEY }, 'worker')
        .errors,
    ).toEqual([]);
  });

  it('the WORKER does need MFA_SECRET_ENC_KEY: it decrypts webhook signing secrets', () => {
    expect(checkEnv({ APP_DATABASE_URL: DB, DATABASE_URL: OWNER_DB }, 'worker').errors).toEqual([
      expect.stringMatching(/^MFA_SECRET_ENC_KEY is required/),
    ]);
  });

  it('DATABASE_URL is required at RUNTIME by both — pg-boss uses it, not just migrations', () => {
    expect(checkEnv({ APP_DATABASE_URL: DB, MFA_SECRET_ENC_KEY: KEY }, 'worker').errors).toEqual([
      expect.stringMatching(/^DATABASE_URL is required \(.*pg-boss/),
    ]);
  });
});

describe('formats', () => {
  it('rejects an encryption key that is not 32 bytes, as the ciphers would', () => {
    const { errors } = checkEnv(
      good({ MFA_SECRET_ENC_KEY: randomBytes(16).toString('base64') }),
      'api',
    );
    expect(errors).toEqual([
      expect.stringMatching(/^MFA_SECRET_ENC_KEY must decode from base64 to exactly 32 bytes/),
    ]);
  });

  it('accepts any key the ciphers accept, including base64url — no new refusals', () => {
    const urlSafe = randomBytes(32).toString('base64url');
    expect(checkEnv(good({ MFA_SECRET_ENC_KEY: urlSafe }), 'api').errors).toEqual([]);
  });

  it('rejects a database setting that is not a postgres URL', () => {
    expect(checkEnv(good({ APP_DATABASE_URL: 'mysql://x' }), 'api').errors).toEqual([
      'APP_DATABASE_URL must be a postgres:// or postgresql:// URL.',
    ]);
  });

  it.each(['abc', '0', '-5', '1.5', '10s'])(
    'rejects a non-positive-integer TTL (%s) instead of silently becoming NaN',
    (bad) => {
      expect(checkEnv(good({ ACCESS_TOKEN_TTL_SECONDS: bad }), 'api').errors).toEqual([
        expect.stringMatching(/^ACCESS_TOKEN_TTL_SECONDS must be a positive whole number/),
      ]);
    },
  );

  it('rejects an unknown notification transport and a malformed WEB_ORIGIN', () => {
    expect(checkEnv(good({ NOTIFY_TRANSPORT: 'smtp' }), 'api').errors).toEqual([
      'NOTIFY_TRANSPORT must be "console" or "http".',
    ]);
    expect(checkEnv(good({ WEB_ORIGIN: 'https://app.example.com/' }), 'api').errors[0]).toMatch(
      /^WEB_ORIGIN must be/,
    );
    expect(
      checkEnv(good({ WEB_ORIGIN: 'https://a.example.com, https://b.example.com' }), 'api').errors,
    ).toEqual([]);
  });

  it('rejects an invalid TRUST_PROXY', () => {
    expect(checkEnv(good({ TRUST_PROXY: 'yes' }), 'api').errors[0]).toMatch(/^TRUST_PROXY must be/);
  });
});

describe('development stays exactly as permissive as before', () => {
  it('the .env.example values start the API and the worker with no errors', () => {
    expect(checkEnv(EXAMPLE, 'api').errors).toEqual([]);
    expect(checkEnv(EXAMPLE, 'worker').errors).toEqual([]);
  });

  it('NODE_ENV unset is treated as development', () => {
    const { NODE_ENV: _drop, ...rest } = EXAMPLE;
    expect(checkEnv(rest, 'api').errors).toEqual([]);
  });
});

describe('the placeholder key shipped before this change', () => {
  it('was 35 bytes and could never start a backend — the validator says so plainly', () => {
    const OLD = 'Q2hhbmdlTWVEZXZPbmx5S2V5Rm9yTG9jYWxVc2VPbmx5ISE=';
    expect(Buffer.from(OLD, 'base64').length).toBe(35);
    expect(checkEnv({ ...EXAMPLE, MFA_SECRET_ENC_KEY: OLD }, 'api').errors).toEqual([
      expect.stringMatching(/^MFA_SECRET_ENC_KEY must decode from base64 to exactly 32 bytes/),
    ]);
  });
});

describe('production refuses what development tolerates', () => {
  it('a complete production configuration passes with no errors and no warnings', () => {
    expect(checkEnv(prod(), 'api')).toEqual({ errors: [], warnings: [] });
  });

  it('refuses every published example secret', () => {
    const { errors } = checkEnv(
      { ...EXAMPLE, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com' },
      'api',
    );
    for (const k of [
      'JWT_SECRET',
      'REQUEST_OTP_SECRET',
      'MFA_SECRET_ENC_KEY',
      'SUBMISSION_STAGING_ENC_KEY',
      'APP_DATABASE_URL',
      'DATABASE_URL',
    ]) {
      expect(errors.some((e) => e.startsWith(`${k} is still the published example value`))).toBe(
        true,
      );
    }
  });

  it('refuses a short JWT secret', () => {
    expect(checkEnv(prod({ JWT_SECRET: 'short-but-real' }), 'api').errors).toEqual([
      'JWT_SECRET must be at least 32 characters in production (it signs every tenant claim).',
    ]);
  });

  it('only WARNS where the customer installer legitimately differs (no WEB_ORIGIN, console transport)', () => {
    const { errors, warnings } = checkEnv(
      prod({ WEB_ORIGIN: '', POSTMARK_API_KEY: '', MSG91_AUTH_KEY: '' }),
      'api',
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(/^WEB_ORIGIN is unset/),
      expect.stringMatching(/^No real e-mail or SMS provider is configured/),
    ]);
  });

  it('the customer installer as it is configured today still STARTS — every difference is a warning', () => {
    // Local evidence, no CA bundle (the hosted dev DB uses no-verify), pg-boss
    // on the owner role, no WEB_ORIGIN, console transport.
    const installer = good({
      NODE_ENV: 'production',
      APP_DATABASE_URL: `${DB}?sslmode=no-verify`,
      DATABASE_URL: `${OWNER_DB}?sslmode=no-verify`,
    });
    const { errors, warnings } = checkEnv(installer, 'api');
    expect(errors).toEqual([]);
    for (const w of [
      /^IMPORT_EVIDENCE_STORE=local/,
      /certificate is NOT verified for APP_DATABASE_URL, DATABASE_URL\./,
      /^pg-boss is using DATABASE_URL/,
    ]) {
      expect(warnings.some((x) => w.test(x))).toBe(true);
    }
  });

  it('warns about a plain-http dashboard origin, but not about localhost', () => {
    expect(checkEnv(prod({ WEB_ORIGIN: 'http://app.example.com' }), 'api').warnings).toEqual([
      expect.stringMatching(/plain-http/),
    ]);
    expect(checkEnv(prod({ WEB_ORIGIN: 'http://localhost:3000' }), 'api').warnings).toEqual([]);
  });
});

describe('the thrown error never contains a secret', () => {
  it('lists problems by name only', () => {
    const secret = 'change_me_dev_jwt_secret';
    const env = prod({
      JWT_SECRET: secret,
      APP_DATABASE_URL: 'postgresql://dpdp_app:dpdp_app_local_dev_only@h/db',
    });
    let message = '';
    try {
      validateEnv('api')(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^The api cannot start: 3 environment problem\(s\)/);
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('dpdp_app_local_dev_only');
    expect(message).not.toContain('s3cret-pw');
    expect(message).not.toContain('0wner-pw');
  });

  it('returns the configuration unchanged when it is valid', () => {
    const env = good();
    expect(validateEnv('api')(env)).toBe(env);
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
  ])('%p -> %p', (raw, want) => {
    expect(parseTrustProxy(raw as string | undefined)).toBe(want);
  });

  it('an invalid value is undefined (reported at startup, never silently trusted)', () => {
    expect(parseTrustProxy('yes')).toBeUndefined();
    expect(parseTrustProxy('10.0.0.0/8')).toBeUndefined();
  });
});

describe('maskRecipient', () => {
  it('keeps enough to correlate, never the address', () => {
    expect(maskRecipient('asha.rao@example.com')).toBe('a***@example.com');
    expect(maskRecipient('+91 98765 43210')).toBe('***3210');
    expect(maskRecipient('x')).toBe('***');
  });
});

describe('deployment-readiness settings', () => {
  it('PGBOSS_DATABASE_URL alone satisfies pg-boss — the runtime no longer needs the owner credential', () => {
    expect(
      checkEnv({ APP_DATABASE_URL: DB, PGBOSS_DATABASE_URL: DB, MFA_SECRET_ENC_KEY: KEY }, 'worker')
        .errors,
    ).toEqual([]);
    expect(checkEnv({ APP_DATABASE_URL: DB, MFA_SECRET_ENC_KEY: KEY }, 'worker').errors).toEqual([
      expect.stringMatching(/^DATABASE_URL is required .*unless PGBOSS_DATABASE_URL is set\.$/),
    ]);
  });

  it('a configured CA bundle that is missing or not a certificate STOPS startup (never a silent fallback)', () => {
    expect(
      checkEnv(good({ DATABASE_SSL_CA_FILE: join(CERT_DIR, 'missing.pem') }), 'api').errors,
    ).toEqual([expect.stringMatching(/^DATABASE_SSL_CA_FILE could not be read/)]);
    expect(checkEnv(good({ DATABASE_SSL_CA_FILE: NOT_A_CERT }), 'worker').errors).toEqual([
      expect.stringMatching(/does not contain a PEM certificate/),
    ]);
  });

  it('a URL that verifies on its own (verify-full + sslrootcert) is not warned about', () => {
    const url = `${DB}?sslmode=verify-full&sslrootcert=/certs/rds.pem`;
    const env = prod({
      DATABASE_SSL_CA_FILE: '',
      APP_DATABASE_URL: url,
      PGBOSS_DATABASE_URL: url,
      DATABASE_URL: url,
    });
    expect(checkEnv(env, 'api').warnings).toEqual([]);
  });

  it('an S3 evidence store without a bucket stops the API (the worker never imports, so it is not asked)', () => {
    expect(checkEnv(good({ IMPORT_EVIDENCE_STORE: 's3' }), 'api').errors).toEqual([
      'IMPORT_EVIDENCE_S3_BUCKET is required when IMPORT_EVIDENCE_STORE=s3.',
    ]);
    expect(checkEnv(good({ IMPORT_EVIDENCE_STORE: 's3' }), 'worker').errors).toEqual([]);
  });

  it('the public example JWT_SECRET is LOUDLY warned about even in development', () => {
    const { errors, warnings } = checkEnv(EXAMPLE, 'api');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(/^JWT_SECRET is the PUBLIC example value .*rotate-jwt-secret/),
    ]);
    expect(checkEnv(good(), 'api').warnings).toEqual([]);
  });
});

describe('the shipped .env.example', () => {
  const { execFileSync } =
    jest.requireActual<typeof import('node:child_process')>('node:child_process');
  const { readFileSync: read, copyFileSync } =
    jest.requireActual<typeof import('node:fs')>('node:fs');
  const ROOT = join(__dirname, '..', '..', '..');
  const parse = (file: string): Record<string, string> =>
    Object.fromEntries(
      read(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!, m[2]!.trim()]),
    );

  it('as copied, the API refuses to start for exactly ONE reason: no JWT_SECRET yet', () => {
    expect(checkEnv(parse(join(ROOT, '.env.example')), 'api').errors).toEqual([
      expect.stringMatching(/^JWT_SECRET is required/),
    ]);
    expect(checkEnv(parse(join(ROOT, '.env.example')), 'worker').errors).toEqual([]);
  });

  it('after `node scripts/rotate-jwt-secret.mjs` it starts, with no placeholder warning', () => {
    const copy = join(CERT_DIR, '.env');
    copyFileSync(join(ROOT, '.env.example'), copy);
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'rotate-jwt-secret.mjs'), copy], {
      encoding: 'utf8',
    });
    expect(checkEnv(parse(copy), 'api')).toEqual({ errors: [], warnings: [] });
  });
});
