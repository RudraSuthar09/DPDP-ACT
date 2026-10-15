/**
 * The shared outbound transport for agent -> DPDP backend HTTP calls.
 *
 * Builds the undici dispatchers that enrollment.ts's single fetch() call site
 * uses: a direct Agent, and one ProxyAgent per configured proxy. HTTPS
 * destinations go through the proxy as an HTTP CONNECT tunnel, so TLS is
 * end to end between the agent and DPDP and the proxy never sees the device
 * token. Proxy Basic credentials are sent only to the proxy
 * (Proxy-Authorization on the CONNECT request).
 *
 * Every connection — direct, through a tunnel, and to an https:// proxy
 * itself — verifies certificates against the trust list from tls-trust.ts.
 * Nothing here relaxes verification, and nothing retries a failed proxied
 * request directly: a configured proxy that fails is a failed request.
 *
 * Timeouts are undici's defaults (connect 10 s, headers 300 s, body 300 s),
 * the same values Node's global fetch used before this layer existed.
 */
import { Agent, Pool, ProxyAgent, type Dispatcher } from 'undici';
import { selectProxy, type ProxyEndpoint, type ProxySettings, type ProxySource } from './network-config';

export interface Transport {
  dispatcherFor(url: string): Dispatcher;
  usesProxy(url: string): boolean;
  readonly summary: TransportSummary;
  close(): Promise<void>;
}

/** Safe to log and to expose on the local status endpoint: no hosts, no credentials. */
export interface TransportSummary {
  proxy: ProxySource;
  proxyAuthentication: boolean;
  noProxyRules: number;
  customTrust: boolean;
}

export function createTransport(opts: { proxy: ProxySettings; ca: string[] | undefined }): Transport {
  const connectTls = opts.ca ? { ca: opts.ca } : undefined;
  const direct = new Agent(connectTls ? { connect: connectTls } : {});
  const proxyAgents = new Map<string, ProxyAgent>();

  const proxyAgentFor = (endpoint: ProxyEndpoint): ProxyAgent => {
    let agent = proxyAgents.get(endpoint.uri);
    if (!agent) {
      agent = new ProxyAgent({
        uri: endpoint.uri,
        token: endpoint.credentials ? basicToken(endpoint.credentials.username, endpoint.credentials.password) : undefined,
        requestTls: connectTls,
        proxyTls: connectTls,
        clientFactory: tunnelFailsFast,
      });
      proxyAgents.set(endpoint.uri, agent);
    }
    return agent;
  };

  const endpoints = [opts.proxy.httpProxy, opts.proxy.httpsProxy].filter((e): e is ProxyEndpoint => e !== null);
  return {
    dispatcherFor(url) {
      const endpoint = selectProxy(opts.proxy, url);
      return endpoint ? proxyAgentFor(endpoint) : direct;
    },
    usesProxy(url) {
      return selectProxy(opts.proxy, url) !== null;
    },
    summary: {
      proxy: opts.proxy.source,
      proxyAuthentication: endpoints.some((e) => e.credentials !== null),
      noProxyRules: opts.proxy.noProxy.length,
      customTrust: opts.ca !== undefined,
    },
    async close() {
      await Promise.allSettled([direct.close(), ...[...proxyAgents.values()].map((a) => a.close())]);
    },
  };
}

/**
 * Works around an undici 6.x behaviour (measured with 6.29.0: ~9,000 CONNECT
 * attempts in 3 s, request never settles): when the proxy closes the socket
 * before answering CONNECT, the failure carries code UND_ERR_SOCKET, which
 * undici's client treats as recoverable and immediately reconnects, forever.
 * Re-raising any tunnel-setup failure under our own code (cause preserved for
 * classifyTransportError) makes undici fail the request once instead.
 */
const TUNNEL_SETUP_FAILED = 'DPDP_PROXY_TUNNEL_SETUP_FAILED';

function tunnelFailsFast(origin: URL, options: object): Dispatcher {
  const pool = new Pool(origin, options as Pool.Options);
  const original = pool.connect.bind(pool) as (opts: Dispatcher.ConnectOptions) => Promise<Dispatcher.ConnectData>;
  (pool as unknown as { connect: typeof original }).connect = async (opts) => {
    try {
      return await original(opts);
    } catch (err) {
      throw Object.assign(new Error('Proxy tunnel setup failed', { cause: err }), { code: TUNNEL_SETUP_FAILED });
    }
  };
  return pool;
}

function basicToken(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

// --- failure classification --------------------------------------------------

export type NetworkErrorCode =
  | 'PROXY_AUTH_FAILED'
  | 'PROXY_REFUSED'
  | 'PROXY_UNREACHABLE'
  | 'DNS_FAILED'
  | 'CONNECT_FAILED'
  | 'TLS_UNTRUSTED'
  | 'TLS_HOSTNAME_MISMATCH'
  | 'TLS_FAILED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

/** A transport-level failure (no HTTP response from DPDP). The message is
 *  actionable and never contains a URL, host, credential or token. */
export class TransportError extends Error {
  constructor(
    public readonly code: NetworkErrorCode,
    message: string,
    public readonly viaProxy: boolean,
    public readonly retryable: boolean,
    /** Low-level code such as ECONNREFUSED or SELF_SIGNED_CERT_IN_CHAIN, if any. */
    public readonly detail: string | null,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const TLS_UNTRUSTED_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'INVALID_CA',
  'CERT_CHAIN_TOO_LONG',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function causeChain(err: unknown): Array<{ code?: string; message: string }> {
  const out: Array<{ code?: string; message: string }> = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({ code: typeof e.code === 'string' ? e.code : undefined, message: typeof e.message === 'string' ? e.message : '' });
    cur = e.cause;
  }
  return out;
}

const TRUST_HINT =
  'If your network inspects TLS, trust your organisation\'s CA with "tls.extraCaCertsFile" or ' +
  '"tls.useWindowsCertificateStore" in config.json, then restart the service. Certificate checks are never disabled.';

export function classifyTransportError(err: unknown, viaProxy: boolean): TransportError {
  if (err instanceof TransportError) return err;
  const chain = causeChain(err);
  const codes = chain.map((c) => c.code).filter((c): c is string => Boolean(c));
  const where = viaProxy ? 'through the configured proxy' : 'directly';

  const proxyStatus = chain.map((c) => /Proxy response \((\d{3})\)/.exec(c.message)).find(Boolean);
  if (proxyStatus) {
    const status = Number(proxyStatus[1]);
    if (status === 407) {
      return new TransportError(
        'PROXY_AUTH_FAILED',
        'The outbound proxy refused the Gateway (HTTP 407 Proxy Authentication Required). Check proxy-credentials.json ' +
          '(or the user info in HTTPS_PROXY). Only Basic proxy authentication is supported; NTLM/Kerberos-only proxies must allow this computer without authentication.',
        true,
        false,
        'HTTP 407',
      );
    }
    return new TransportError(
      'PROXY_REFUSED',
      `The outbound proxy refused to open a tunnel to DPDP (HTTP ${status}). Ask the network team to allow HTTPS (CONNECT) to the DPDP workspace host.`,
      true,
      status >= 500,
      `HTTP ${status}`,
    );
  }

  const tlsCode = codes.find((c) => TLS_UNTRUSTED_CODES.has(c));
  if (tlsCode) {
    return new TransportError('TLS_UNTRUSTED', `TLS certificate verification failed (${tlsCode}) connecting ${where}. ${TRUST_HINT}`, viaProxy, false, tlsCode);
  }
  if (codes.includes('ERR_TLS_CERT_ALTNAME_INVALID')) {
    return new TransportError(
      'TLS_HOSTNAME_MISMATCH',
      `TLS certificate verification failed: the certificate does not match the DPDP host name (connecting ${where}). Check the workspace URL; a TLS-inspecting proxy must issue certificates for the real host name.`,
      viaProxy,
      false,
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
  }
  const otherTls = codes.find((c) => c.startsWith('ERR_TLS_') || c.startsWith('ERR_SSL_') || c.startsWith('ERR_OSSL_'));
  if (otherTls) {
    return new TransportError('TLS_FAILED', `TLS negotiation failed (${otherTls}) connecting ${where}.`, viaProxy, false, otherTls);
  }

  const dns = codes.find((c) => DNS_CODES.has(c));
  const connect = codes.find((c) => CONNECT_CODES.has(c));
  const timeout = codes.find((c) => TIMEOUT_CODES.has(c));
  if (viaProxy && (dns || connect || timeout)) {
    // Through a proxy the only connection this machine opens is to the proxy.
    const detail = (dns ?? connect ?? timeout)!;
    return new TransportError(
      'PROXY_UNREACHABLE',
      `The configured outbound proxy could not be reached or closed the connection (${detail}). The Gateway does not fall back to a direct connection; check the proxy address and that it is running.`,
      true,
      true,
      detail,
    );
  }
  if (dns) {
    return new TransportError('DNS_FAILED', `The DPDP host name could not be resolved (${dns}). Check DNS, or whether this network requires a proxy.`, false, true, dns);
  }
  if (timeout) {
    return new TransportError('TIMEOUT', `The connection to DPDP timed out (${timeout}). Check the firewall, or whether this network requires a proxy.`, false, true, timeout);
  }
  if (connect) {
    return new TransportError('CONNECT_FAILED', `Could not connect to DPDP (${connect}). Check the firewall, or whether this network requires a proxy.`, false, true, connect);
  }
  return new TransportError('NETWORK_ERROR', `The request to DPDP failed ${where} without an HTTP response.`, viaProxy, true, codes[0] ?? null);
}
