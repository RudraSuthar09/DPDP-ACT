// eslint-disable-next-line @typescript-eslint/no-require-imports
const ConnectionParameters = require('pg/lib/connection-parameters');
import type { PeerCertificate } from 'node:tls';
import {
  DatabaseTlsConfigError,
  hostOf,
  pgConnectionOptions,
  stripTlsParams,
  urlVerifiesServer,
} from './pg-tls';

/**
 * Database TLS. The assertions go through node-postgres's OWN
 * ConnectionParameters — the object a real connection is built from — so they
 * prove what pg will actually do, not merely what our helper returns.
 */

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB...fake...\n-----END CERTIFICATE-----\n';
const read = (p: string) => {
  if (p === '/certs/rds.pem') return PEM;
  if (p === '/certs/not-a-cert.txt') return 'hello';
  throw new Error('ENOENT');
};
const effective = (opts: { connectionString: string; ssl?: unknown }) =>
  new ConnectionParameters(opts).ssl;

describe('without a CA bundle — unchanged behaviour', () => {
  it('uses the URL exactly as given', () => {
    const url = 'postgresql://u:p@h.example:5432/db?sslmode=no-verify';
    expect(pgConnectionOptions(url, undefined, read)).toEqual({ connectionString: url });
    expect(pgConnectionOptions(url, '', read)).toEqual({ connectionString: url });
  });
});

describe('with DATABASE_SSL_CA_FILE — the server certificate is VERIFIED', () => {
  it('pg ends up verifying against the bundle, hostname checks included', () => {
    const opts = pgConnectionOptions(
      'postgresql://u:p@db.abc.ap-south-1.rds.amazonaws.com:5432/dpdp',
      '/certs/rds.pem',
      read,
    );
    expect(effective(opts)).toMatchObject({ ca: PEM, rejectUnauthorized: true });
    expect(typeof effective(opts).checkServerIdentity).toBe('function');
  });

  it('a URL saying sslmode=no-verify can NOT switch verification off (the override trap)', () => {
    const url = 'postgresql://u:p@db.example:5432/dpdp?sslmode=no-verify';
    // The trap itself: passing ssl beside that URL is silently ignored by pg.
    expect(
      effective({ connectionString: url, ssl: { ca: PEM, rejectUnauthorized: true } }),
    ).toEqual({ rejectUnauthorized: false });
    // Our helper closes it.
    expect(effective(pgConnectionOptions(url, '/certs/rds.pem', read))).toMatchObject({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  it.each([
    'ssl=true',
    'sslmode=disable',
    'sslmode=require',
    'sslrootcert=/tmp/x.pem',
    'uselibpqcompat=true&sslmode=require',
  ])('removes "%s" from the URL', (q) => {
    const out = pgConnectionOptions(`postgresql://u:p@h/db?${q}`, '/certs/rds.pem', read);
    expect(out.connectionString).toBe('postgresql://u:p@h/db');
  });

  it('keeps every non-TLS parameter', () => {
    expect(
      stripTlsParams(
        'postgresql://u:p@h/db?sslmode=no-verify&application_name=x&connect_timeout=5',
      ),
    ).toBe('postgresql://u:p@h/db?application_name=x&connect_timeout=5');
  });

  it('an unreadable bundle fails loudly — never a silent fallback to no TLS', () => {
    expect(() => pgConnectionOptions('postgresql://u:p@h/db', '/certs/missing.pem', read)).toThrow(
      DatabaseTlsConfigError,
    );
    expect(() => pgConnectionOptions('postgresql://u:p@h/db', '/certs/missing.pem', read)).toThrow(
      /could not be read/,
    );
  });

  it('a file that is not a PEM certificate is refused', () => {
    expect(() =>
      pgConnectionOptions('postgresql://u:p@h/db', '/certs/not-a-cert.txt', read),
    ).toThrow(/does not contain a PEM certificate/);
  });

  it('error messages never contain the connection string (it carries a password)', () => {
    try {
      pgConnectionOptions('postgresql://u:SECRETPW@h/db', '/certs/missing.pem', read);
    } catch (err) {
      expect(String(err)).not.toContain('SECRETPW');
    }
  });
});

describe('urlVerifiesServer', () => {
  it('is true only for verify-full WITH a root certificate', () => {
    expect(urlVerifiesServer('postgresql://h/db?sslmode=verify-full&sslrootcert=/c.pem')).toBe(
      true,
    );
    expect(urlVerifiesServer('postgresql://h/db?sslmode=verify-full')).toBe(false);
    expect(urlVerifiesServer('postgresql://h/db?sslmode=no-verify')).toBe(false);
    expect(urlVerifiesServer('postgresql://h/db')).toBe(false);
  });
});

describe('the certificate must name the host actually dialled', () => {
  const cert = (san: string) =>
    ({ subject: { CN: 'x' }, subjectaltname: san }) as unknown as PeerCertificate;
  const identity = (url: string) =>
    pgConnectionOptions(url, '/certs/rds.pem', read).ssl!.checkServerIdentity;

  it('an RDS endpoint is checked against its own DNS name', () => {
    const check = identity('postgresql://u:p@dpdp.abc123.ap-south-1.rds.amazonaws.com:5432/dpdp');
    expect(check('ignored', cert('DNS:dpdp.abc123.ap-south-1.rds.amazonaws.com'))).toBeUndefined();
    expect(
      (check('ignored', cert('DNS:attacker.example.com')) as { code?: string } | undefined)?.code,
    ).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('an IP-addressed host is checked against that IP — NOT against "localhost" (the pg default)', () => {
    const check = identity('postgresql://u:p@10.0.3.17:5432/dpdp');
    expect((check('ignored', cert('DNS:localhost')) as { code?: string } | undefined)?.code).toBe(
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
    expect(check('ignored', cert('IP Address:10.0.3.17'))).toBeUndefined();
  });

  it('the servername pg passes is ignored: identity always comes from the configured host', () => {
    const check = identity('postgresql://u:p@db.internal:5432/dpdp');
    expect(
      (check('db.internal', cert('DNS:other.internal')) as { code?: string } | undefined)?.code,
    ).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('hostOf handles IPv6 and refuses a URL without a host, never echoing the URL', () => {
    expect(hostOf('postgresql://u:p@[::1]:5432/db')).toBe('::1');
    expect(() => hostOf('not a url with SECRETPW')).toThrow(DatabaseTlsConfigError);
    try {
      hostOf('not a url with SECRETPW');
    } catch (e) {
      expect(String(e)).not.toContain('SECRETPW');
    }
  });
});
