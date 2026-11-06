import { readFileSync } from 'node:fs';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

/**
 * Connection options for every PostgreSQL pool the backend opens (the RLS
 * pool in TenantDatabaseService, pg-boss, and the worker leadership lock).
 *
 * WHY THIS EXISTS. With DATABASE_SSL_CA_FILE set, the server's certificate is
 * verified against that bundle (on AWS: the official Amazon RDS CA bundle,
 * shipped in the backend image) AND the server's hostname is checked against
 * the certificate. That is a real verification — not `rejectUnauthorized:
 * false`, not `sslmode=no-verify`.
 *
 * THE TRAP IT CLOSES. node-postgres builds its settings as
 * `Object.assign({}, options, parse(connectionString))`: anything in the URL
 * OVERRIDES the options passed beside it. A database URL carrying
 * `?sslmode=no-verify` (exactly what the hosted dev database uses today)
 * would therefore silently switch verification off however carefully `ssl`
 * was set. So when a CA bundle is configured, every TLS parameter is removed
 * from the URL first, and the only TLS setting left is the verifying one.
 *
 * Without DATABASE_SSL_CA_FILE nothing changes: the URL is used exactly as
 * before (local development, the hosted dev database, the customer installer).
 */
export interface PgConnectionOptions {
  connectionString: string;
  ssl?: {
    ca: string;
    rejectUnauthorized: true;
    checkServerIdentity: (servername: string, cert: PeerCertificate) => Error | undefined;
  };
}

/** Every URL parameter through which node-postgres / pg-connection-string
 *  can change TLS behaviour. */
const TLS_URL_PARAMS = [
  'ssl',
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslcrl',
  'sslnegotiation',
  'uselibpqcompat',
];

export class DatabaseTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseTlsConfigError';
  }
}

export function pgConnectionOptions(
  connectionString: string,
  caFile: string | undefined,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): PgConnectionOptions {
  if (!caFile || caFile.trim() === '') return { connectionString };
  const host = hostOf(connectionString);
  return {
    connectionString: stripTlsParams(connectionString),
    ssl: {
      ca: readCaBundle(caFile.trim(), readFile),
      rejectUnauthorized: true,
      // node-postgres only tells TLS the server's name when the host is a DNS
      // name; for an IP address Node then checks the certificate against the
      // literal name "localhost" — so any certificate issued for "localhost"
      // by a trusted CA would pass. Verifying against the host actually in
      // the connection string closes that for every kind of host.
      checkServerIdentity: (_servername: string, cert: PeerCertificate) =>
        checkServerIdentity(host, cert),
    },
  };
}

/** The host from a postgres URL (IPv6 brackets removed). Refuses a URL with
 *  no host rather than verifying against nothing. */
export function hostOf(connectionString: string): string {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new DatabaseTlsConfigError(
      'A database URL could not be parsed to verify its server certificate.',
    );
  }
  if (!hostname)
    throw new DatabaseTlsConfigError(
      'A database URL has no host to verify the server certificate against.',
    );
  return hostname.replace(/^\[|\]$/g, '');
}

/** Reads and sanity-checks a PEM CA bundle. The message names the setting,
 *  never the file's contents. */
export function readCaBundle(
  caFile: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  let pem: string;
  try {
    pem = readFile(caFile);
  } catch {
    throw new DatabaseTlsConfigError(`DATABASE_SSL_CA_FILE could not be read (${caFile}).`);
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new DatabaseTlsConfigError(
      `DATABASE_SSL_CA_FILE (${caFile}) does not contain a PEM certificate.`,
    );
  }
  return pem;
}

export function stripTlsParams(connectionString: string): string {
  const q = connectionString.indexOf('?');
  if (q < 0) return connectionString;
  const base = connectionString.slice(0, q);
  const params = new URLSearchParams(connectionString.slice(q + 1));
  for (const p of TLS_URL_PARAMS) params.delete(p);
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base;
}

/** What a URL asks for on its own, for the startup warning: verification is
 *  only real with a CA bundle or an explicit verify-full + sslrootcert. */
export function urlVerifiesServer(connectionString: string): boolean {
  const q = connectionString.indexOf('?');
  if (q < 0) return false;
  const params = new URLSearchParams(connectionString.slice(q + 1));
  return params.get('sslmode') === 'verify-full' && !!params.get('sslrootcert');
}
