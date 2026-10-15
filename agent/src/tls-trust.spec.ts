import { readFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { AgentConfigError } from './config';
import { buildTrustedCaList, parseCaBundle, summarizeTlsTrust } from './tls-trust';

const TLS_DIR = path.join(__dirname, '__fixtures__', 'tls');
const CA = readFileSync(path.join(TLS_DIR, 'test-ca.pem'), 'utf8');
const LEAF = readFileSync(path.join(TLS_DIR, 'localhost.pem'), 'utf8');
const KEY = readFileSync(path.join(TLS_DIR, 'localhost.key'), 'utf8');

describe('parseCaBundle', () => {
  it('accepts a CA certificate (and a bundle of several)', () => {
    expect(parseCaBundle(CA, 'L')).toHaveLength(1);
    expect(parseCaBundle(`${CA}\n${CA}`, 'L')).toHaveLength(2);
  });

  it('rejects a server (non-CA) certificate', () => {
    expect(() => parseCaBundle(LEAF, 'L')).toThrow(/not a CA certificate/);
  });

  it('rejects a file that contains a private key', () => {
    expect(() => parseCaBundle(`${CA}\n${KEY}`, 'L')).toThrow(/private key/);
  });

  it('rejects an empty or non-PEM file', () => {
    expect(() => parseCaBundle('', 'L')).toThrow(/no PEM certificates/);
    expect(() => parseCaBundle('-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----', 'L')).toThrow(/could not be parsed/);
  });

  it('rejects an expired or not-yet-valid CA', () => {
    expect(() => parseCaBundle(CA, 'L', new Date('2200-01-01'))).toThrow(/expired/);
    expect(() => parseCaBundle(CA, 'L', new Date('2000-01-01'))).toThrow(/not valid until/);
  });

  it('errors are AgentConfigError and name the setting, not the path', () => {
    try {
      parseCaBundle(LEAF, '"tls.extraCaCertsFile" in config.json');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentConfigError);
      expect((e as Error).message).toContain('tls.extraCaCertsFile');
    }
  });
});

describe('buildTrustedCaList', () => {
  it('returns undefined (Node default trust, untouched) when nothing is configured', () => {
    expect(buildTrustedCaList({ extraCaCertificates: [], useWindowsCertificateStore: false })).toBeUndefined();
  });

  it('ADDS extra CAs to the default list; never replaces it', () => {
    const list = buildTrustedCaList({ extraCaCertificates: [CA], useWindowsCertificateStore: false })!;
    expect(list).toContain(CA);
    expect(list.length).toBeGreaterThan(100); // the bundled Mozilla roots are still there
    for (const root of tls.rootCertificates.slice(0, 5)) expect(list).toContain(root);
  });

  it('adds the Windows store via tls.getCACertificates("system") (mocked source)', () => {
    const fake = jest.fn((type?: string) => (type === 'system' ? ['SYSTEM-CA'] : ['DEFAULT-CA']));
    expect(buildTrustedCaList({ extraCaCertificates: ['EXTRA'], useWindowsCertificateStore: true }, fake)).toEqual(['DEFAULT-CA', 'SYSTEM-CA', 'EXTRA']);
    expect(fake).toHaveBeenCalledWith('default');
    expect(fake).toHaveBeenCalledWith('system');
  });

  it('the Windows store option fails loudly on a Node.js without getCACertificates', () => {
    expect(() => buildTrustedCaList({ extraCaCertificates: [], useWindowsCertificateStore: true }, null)).toThrow(/22\.15/);
  });

  const winIt = process.platform === 'win32' ? it : it.skip;
  winIt('REAL Windows certificate store: this Node.js reads it (count only)', () => {
    const list = buildTrustedCaList({ extraCaCertificates: [], useWindowsCertificateStore: true })!;
    expect(list.length).toBeGreaterThan(tls.rootCertificates.length);
  });
});

it('summarizeTlsTrust reports counts and booleans only', () => {
  expect(summarizeTlsTrust({ extraCaCertificates: [CA], useWindowsCertificateStore: true }, { NODE_EXTRA_CA_CERTS: 'C:\\x.pem' })).toEqual({
    windowsCertificateStore: true,
    extraCaCertificates: 1,
    nodeExtraCaCerts: true,
  });
});
