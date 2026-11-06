import { Logger } from '@nestjs/common';
import { parseImportEvidenceConfig } from '../modules/inventory/import-evidence.config';
import { readCaBundle, urlVerifiesServer } from '../database/pg-tls';

/**
 * Startup validation of the environment, for the two backend processes.
 *
 * Before this existed, each secret was checked lazily by the class that uses
 * it, so a misconfigured deployment failed one variable at a time, in whatever
 * order Nest happened to construct providers, and a few mistakes failed not at
 * all: a production deployment started happily with the `.env.example`
 * placeholder JWT secret (so anyone with this repository could mint a token
 * for any tenant), and an unparsable TTL silently became `NaN`.
 *
 * Now every problem is reported at once, before anything connects anywhere,
 * naming the variable and never echoing its value.
 *
 * WHAT IS REQUIRED DEPENDS ON THE PROCESS. The worker deliberately loads no
 * identity module (see worker.module.ts), so it never needs JWT_SECRET or the
 * submission staging key — demanding them there would hand a background job
 * secrets it has no use for. It DOES need MFA_SECRET_ENC_KEY: its NotifyModule
 * decrypts webhook signing secrets with it.
 *
 * STRICTNESS DEPENDS ON NODE_ENV. Development and CI accept the documented
 * placeholders, unchanged. NODE_ENV=production refuses them. Things that are
 * merely unusual in production (no real e-mail/SMS provider, no WEB_ORIGIN) are
 * warnings, not errors: the customer installer runs NODE_ENV=production with
 * both, on purpose, and must keep starting.
 */

export type BackendProcess = 'api' | 'worker';

/** The AES-256 key check, done EXACTLY as both ciphers do it (decode as
 *  base64, require 32 bytes) — so this accepts precisely what they accept and
 *  can never refuse a key that works today. */
function is32ByteKey(value: string): boolean {
  return Buffer.from(value, 'base64').length === 32;
}

/**
 * Values copied from `.env.example` / the bootstrap migration. Accepting any of
 * these in production means running with a secret that is published in this
 * repository. Matched exactly, plus the two marker substrings the examples use,
 * so a new placeholder written in the same style is caught too.
 */
const KNOWN_PLACEHOLDERS = new Set([
  'change_me_dev_jwt_secret',
  'change_me_dev_otp_secret',
  'change_me_dev_pepper',
  // The 32-byte dev key .env.example now ships, and the 35-byte one it used to
  // ship (which never worked: both ciphers refuse a key that is not 32 bytes).
  'Q2hhbmdlTWVEZXZPbmx5S2V5Rm9yTG9jYWxVc2UhISE=',
  'Q2hhbmdlTWVEZXZPbmx5S2V5Rm9yTG9jYWxVc2VPbmx5ISE=',
]);
const PLACEHOLDER_MARKERS = ['change_me', 'local_dev_only'];

const INTEGER_SETTINGS = [
  'API_PORT',
  'DB_POOL_MAX',
  'ACCESS_TOKEN_TTL_SECONDS',
  'MFA_CHALLENGE_TTL_SECONDS',
  'INVITE_TOKEN_TTL_SECONDS',
  'PLATFORM_ADMIN_TOKEN_TTL_SECONDS',
  'GATEWAY_DEVICE_TOKEN_TTL_SECONDS',
  'GATEWAY_ENROLLMENT_CODE_TTL_SECONDS',
] as const;

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

function present(env: Record<string, unknown>, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikePlaceholder(value: string): boolean {
  return KNOWN_PLACEHOLDERS.has(value) || PLACEHOLDER_MARKERS.some((m) => value.includes(m));
}

/** The pure check. Separate from `validateEnv` so it can be tested without
 *  throwing, and so the messages can be asserted on exactly. */
export function checkEnv(
  env: Record<string, unknown>,
  process: BackendProcess,
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = (present(env, 'NODE_ENV') ?? 'development').toLowerCase() === 'production';

  // --- required -----------------------------------------------------------
  // Both processes: the RLS-enforced runtime pool, and the owner connection
  // pg-boss uses (it creates and maintains its own `pgboss` schema, so it
  // needs DDL rights — this is a RUNTIME dependency, not migrations-only).
  // MFA_SECRET_ENC_KEY in BOTH: the worker's NotifyModule binds the same
  // cipher to decrypt webhook signing secrets for webhook delivery. (Found by
  // booting the real worker; it is not an identity concern there.)
  const required: string[] = ['APP_DATABASE_URL', 'MFA_SECRET_ENC_KEY'];
  if (process === 'api') required.push('JWT_SECRET', 'SUBMISSION_STAGING_ENC_KEY');
  for (const key of required) {
    if (!present(env, key)) errors.push(`${key} is required (${describe(key)}).`);
  }
  // pg-boss: its own least-privilege role when configured, otherwise the owner.
  if (!present(env, 'PGBOSS_DATABASE_URL') && !present(env, 'DATABASE_URL')) {
    errors.push(
      `DATABASE_URL is required (${describe('DATABASE_URL')}), unless PGBOSS_DATABASE_URL is set.`,
    );
  }

  // --- formats --------------------------------------------------------------
  for (const key of ['MFA_SECRET_ENC_KEY', 'SUBMISSION_STAGING_ENC_KEY']) {
    const v = present(env, key);
    if (v && !is32ByteKey(v)) {
      errors.push(
        `${key} must decode from base64 to exactly 32 bytes. Generate one with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
  }
  for (const key of ['APP_DATABASE_URL', 'DATABASE_URL', 'PGBOSS_DATABASE_URL']) {
    const v = present(env, key);
    if (v && !/^postgres(ql)?:\/\//.test(v))
      errors.push(`${key} must be a postgres:// or postgresql:// URL.`);
  }
  for (const key of INTEGER_SETTINGS) {
    const v = present(env, key);
    if (v !== null && !(/^\d+$/.test(v) && Number(v) > 0)) {
      errors.push(`${key} must be a positive whole number (got a non-numeric or zero value).`);
    }
  }
  const trustProxy = present(env, 'TRUST_PROXY');
  if (trustProxy !== null && parseTrustProxy(trustProxy) === undefined) {
    errors.push(
      'TRUST_PROXY must be "false", "true", or a whole number of proxy hops such as "1".',
    );
  }
  const transport = (present(env, 'NOTIFY_TRANSPORT') ?? 'console').toLowerCase();
  if (!['console', 'http'].includes(transport)) {
    errors.push('NOTIFY_TRANSPORT must be "console" or "http".');
  }
  const origins = present(env, 'WEB_ORIGIN');
  if (origins) {
    for (const o of origins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!/^https?:\/\/[^/\s]+$/.test(o)) {
        errors.push(
          'WEB_ORIGIN must be a comma-separated list of exact origins like https://app.example.com (no path, no trailing slash).',
        );
        break;
      }
    }
  }
  // Database TLS: a configured CA bundle must actually be a readable PEM —
  // a typo here must stop the process, never quietly fall back to no checks.
  const caFile = present(env, 'DATABASE_SSL_CA_FILE');
  if (caFile) {
    try {
      readCaBundle(caFile);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  // Import evidence (API only: the worker never imports).
  if (process === 'api') {
    const evidence = parseImportEvidenceConfig(env);
    if (!evidence.ok) errors.push(...evidence.errors);
    else if (production && evidence.config.kind === 'local') {
      warnings.push(
        'IMPORT_EVIDENCE_STORE=local keeps import evidence on the container disk. On a platform that replaces containers ' +
          '(ECS/Fargate) it is lost on every deploy: use IMPORT_EVIDENCE_STORE=s3.',
      );
    }
    // The published example JWT secret is unsafe in ANY environment that more
    // than one person can reach — including a "development" backend pointed at
    // a shared database. A loud warning here (an error in production, below).
    const jwt = present(env, 'JWT_SECRET');
    if (!production && jwt && looksLikePlaceholder(jwt)) {
      warnings.push(
        'JWT_SECRET is the PUBLIC example value from this repository: anyone with the repo can sign tokens this backend accepts. ' +
          'Rotate it now: node scripts/rotate-jwt-secret.mjs (see docs/environment-variables.md, "Rotating JWT_SECRET").',
      );
    }
  }

  // --- production only ------------------------------------------------------
  if (production) {
    for (const key of [
      'JWT_SECRET',
      'REQUEST_OTP_SECRET',
      'MFA_SECRET_ENC_KEY',
      'SUBMISSION_STAGING_ENC_KEY',
      'APP_DATABASE_URL',
      'DATABASE_URL',
      'PGBOSS_DATABASE_URL',
    ]) {
      const v = present(env, key);
      if (v && looksLikePlaceholder(v)) {
        errors.push(
          `${key} is still the published example value from .env.example. Generate a real secret for production.`,
        );
      }
    }
    const jwt = present(env, 'JWT_SECRET');
    if (process === 'api' && jwt && jwt.length < 32) {
      errors.push(
        'JWT_SECRET must be at least 32 characters in production (it signs every tenant claim).',
      );
    }
    // TLS verification: real only with a CA bundle, or a URL that asks for
    // verify-full with its own root certificate. A warning, not an error: the
    // customer installer reaches the hosted dev database with no-verify today.
    if (!caFile) {
      const unverified = ['APP_DATABASE_URL', 'DATABASE_URL', 'PGBOSS_DATABASE_URL'].filter((k) => {
        const v = present(env, k);
        return v !== null && !urlVerifiesServer(v);
      });
      if (unverified.length > 0) {
        warnings.push(
          `The database server's certificate is NOT verified for ${unverified.join(', ')}. Set DATABASE_SSL_CA_FILE ` +
            '(on AWS: the Amazon RDS CA bundle shipped in the image).',
        );
      }
    }
    if (!present(env, 'PGBOSS_DATABASE_URL')) {
      warnings.push(
        'pg-boss is using DATABASE_URL, the schema OWNER credential. Set PGBOSS_DATABASE_URL to a role that owns only the ' +
          'pgboss schema (docs/pgboss-least-privilege.sql) so this process never holds the owner credential.',
      );
    }
    if ((present(env, 'NOTIFY_DEV_ECHO_OTP') ?? '').toLowerCase() === 'true') {
      warnings.push(
        'NOTIFY_DEV_ECHO_OTP=true is ignored in production (one-time codes are never echoed). Remove it.',
      );
    }
    if (process === 'api') {
      if (!origins) {
        warnings.push(
          'WEB_ORIGIN is unset, so the dashboard is only allowed from http://localhost:3000. Set it to the real dashboard origin.',
        );
      } else if (
        origins
          .split(',')
          .some(
            (o) =>
              o.trim().startsWith('http://') &&
              !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o.trim()),
          )
      ) {
        warnings.push(
          'WEB_ORIGIN contains a plain-http origin that is not localhost. Use https in production.',
        );
      }
      const realEmail = present(env, 'POSTMARK_API_KEY') && present(env, 'POSTMARK_FROM_EMAIL');
      const realSms = present(env, 'MSG91_AUTH_KEY') && present(env, 'MSG91_SENDER_ID');
      if (transport === 'console' && (!realEmail || !realSms)) {
        warnings.push(
          `No real ${[!realEmail && 'e-mail', !realSms && 'SMS'].filter(Boolean).join(' or ')} provider is configured and ` +
            'NOTIFY_TRANSPORT=console: those messages will NOT reach anyone. (In production their content is redacted from the log.)',
        );
      }
    }
  }
  return { errors, warnings };
}

/**
 * The `validate` hook for ConfigModule.forRoot. Throws once, listing every
 * problem; logs warnings. Returns the config unchanged.
 */
export function validateEnv(process: BackendProcess) {
  return (env: Record<string, unknown>): Record<string, unknown> => {
    const { errors, warnings } = checkEnv(env, process);
    const logger = new Logger('Environment');
    for (const w of warnings) logger.warn(w);
    if (errors.length > 0) {
      throw new Error(
        `The ${process} cannot start: ${errors.length} environment problem(s).\n` +
          errors.map((e) => `  - ${e}`).join('\n') +
          '\nSee .env.example (local) or .env.production.example (production), and docs/environment-variables.md.',
      );
    }
    return env;
  };
}

/**
 * TRUST_PROXY -> the value Express's 'trust proxy' setting accepts.
 *
 * Behind a load balancer every request arrives from the balancer's address,
 * so without this the per-IP rate limits on the public form and request portal
 * see ONE client and throttle every visitor together. A hop COUNT, not `true`,
 * is what to use in production: `true` trusts whatever X-Forwarded-For a
 * client sends, which lets anyone pick their own rate-limit bucket.
 *
 * Returns undefined for an invalid value (reported by checkEnv), false when
 * unset — Express's own default, and the right one with no proxy in front.
 */
export function parseTrustProxy(raw: string | undefined | null): boolean | number | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return false;
  const v = raw.trim().toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return undefined;
}

function describe(key: string): string {
  switch (key) {
    case 'APP_DATABASE_URL':
      return 'the RLS-enforced runtime connection, role dpdp_app';
    case 'DATABASE_URL':
      return 'the owner connection; pg-boss uses it at runtime for its own schema unless PGBOSS_DATABASE_URL is set';
    case 'JWT_SECRET':
      return 'signs every session token and its tenant claim';
    case 'MFA_SECRET_ENC_KEY':
      return 'decrypts TOTP and per-tenant secrets in the central database; must match every other runtime on that database';
    case 'SUBMISSION_STAGING_ENC_KEY':
      return 'encrypts staged consent-form values in the central database; must match every other runtime on that database';
    default:
      return 'see docs/environment-variables.md';
  }
}
