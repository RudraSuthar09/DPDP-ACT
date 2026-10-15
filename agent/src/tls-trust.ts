/**
 * Which certificate authorities the agent trusts for agent -> DPDP backend
 * (and agent -> https:// proxy) TLS connections.
 *
 * Corporate networks that inspect TLS re-sign traffic with their own CA. The
 * administrator can make the Gateway trust that CA in two ways, both set in
 * config.json and read once when the service starts:
 *   - "tls.extraCaCertsFile": a PEM bundle inside the (admin-only) config
 *     directory, added ON TOP of Node.js's bundled Mozilla roots;
 *   - "tls.useWindowsCertificateStore": also trust the roots in the Windows
 *     certificate store (where Group Policy deploys corporate CAs), read via
 *     Node.js's own tls.getCACertificates('system').
 * NODE_EXTRA_CA_CERTS keeps working too: Node.js folds it into its 'default'
 * list at process start, and that list is the base used here.
 *
 * Verification is never weakened: the list is only ever ADDED to, and no code
 * in this package sets rejectUnauthorized:false or replaces checkServerIdentity
 * (boundary.spec.ts enforces both).
 */
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { AgentConfigError } from './config';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface TlsTrustSettings {
  /** PEM certificates from tls.extraCaCertsFile (already validated). */
  extraCaCertificates: readonly string[];
  useWindowsCertificateStore: boolean;
}

export const DEFAULT_TLS_TRUST: TlsTrustSettings = { extraCaCertificates: [], useWindowsCertificateStore: false };

/**
 * Validates a PEM CA bundle. Rejects anything that is not purely CA
 * certificates: a private key in the file (a common copy/paste mistake that
 * would leave a key readable by every local user), a non-CA (leaf)
 * certificate, an expired or not-yet-valid certificate, or a file with no
 * certificates at all. `label` names the setting; the file path is not echoed.
 */
export function parseCaBundle(pem: string, label: string, now: Date = new Date()): string[] {
  if (/PRIVATE KEY-----/.test(pem)) {
    throw new AgentConfigError(`${label} contains a private key. It must contain only CA certificates; remove the key from the file.`);
  }
  const blocks = pem.match(PEM_CERT) ?? [];
  if (blocks.length === 0) {
    throw new AgentConfigError(`${label} contains no PEM certificates (-----BEGIN CERTIFICATE-----).`);
  }
  return blocks.map((block, i) => {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      throw new AgentConfigError(`${label}: certificate #${i + 1} could not be parsed.`);
    }
    if (!cert.ca) {
      throw new AgentConfigError(`${label}: certificate #${i + 1} is not a CA certificate. Supply your organisation's root or issuing CA, not a server certificate.`);
    }
    if (new Date(cert.validTo).getTime() < now.getTime()) {
      throw new AgentConfigError(`${label}: certificate #${i + 1} expired on ${cert.validTo}.`);
    }
    if (new Date(cert.validFrom).getTime() > now.getTime()) {
      throw new AgentConfigError(`${label}: certificate #${i + 1} is not valid until ${cert.validFrom}.`);
    }
    return block;
  });
}

type CaSource = 'default' | 'system' | 'bundled';
type GetCaCertificates = (type?: CaSource) => string[];

function getCaCertificates(): GetCaCertificates | null {
  const fn = (tls as unknown as { getCACertificates?: GetCaCertificates }).getCACertificates;
  return typeof fn === 'function' ? fn : null;
}

/**
 * The CA list to pass as the `ca` TLS option, or `undefined` to keep Node's
 * default trust (bundled roots + NODE_EXTRA_CA_CERTS) untouched.
 */
export function buildTrustedCaList(settings: TlsTrustSettings, getCa: GetCaCertificates | null = getCaCertificates()): string[] | undefined {
  if (settings.extraCaCertificates.length === 0 && !settings.useWindowsCertificateStore) return undefined;

  const base = getCa ? getCa('default') : [...tls.rootCertificates];
  const merged = [...base];
  if (settings.useWindowsCertificateStore) {
    if (!getCa) {
      throw new AgentConfigError('"tls.useWindowsCertificateStore" needs Node.js 22.15 or later (tls.getCACertificates).');
    }
    merged.push(...getCa('system'));
  }
  merged.push(...settings.extraCaCertificates);
  return [...new Set(merged)];
}

export interface TlsTrustSummary {
  windowsCertificateStore: boolean;
  extraCaCertificates: number;
  /** NODE_EXTRA_CA_CERTS was set in the environment the process started with. */
  nodeExtraCaCerts: boolean;
}

export function summarizeTlsTrust(settings: TlsTrustSettings, env: NodeJS.ProcessEnv): TlsTrustSummary {
  return {
    windowsCertificateStore: settings.useWindowsCertificateStore,
    extraCaCertificates: settings.extraCaCertificates.length,
    nodeExtraCaCerts: Boolean(env.NODE_EXTRA_CA_CERTS?.trim()),
  };
}
