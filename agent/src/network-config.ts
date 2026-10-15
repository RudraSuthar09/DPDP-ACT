/**
 * Outbound proxy configuration for agent -> DPDP backend HTTP calls.
 *
 * Pure (no I/O): resolves WHICH proxy, if any, a control-plane request uses.
 * The dispatcher that actually tunnels through it lives in transport.ts.
 * Database/source-connector traffic and the local listener never consult
 * this module: they are not HTTP calls to the backend.
 *
 * Precedence (first match wins):
 *   1. config.json "proxy": an object ({ url, noProxy }) or the string "none".
 *      An explicit Gateway setting overrides machine-wide variables that may
 *      have been set for other software.
 *   2. Environment: https_proxy / HTTPS_PROXY for https:// destinations,
 *      http_proxy / HTTP_PROXY for http:// ones (lower-case wins, the curl and
 *      Node.js convention), plus no_proxy / NO_PROXY.
 *   3. Direct connection.
 *
 * Loopback destinations (localhost, *.localhost, 127.0.0.0/8, ::1) are ALWAYS
 * direct. Nothing here ever falls back from a configured proxy to a direct
 * connection: if a proxy is selected and fails, the request fails.
 *
 * Messages thrown from here never echo a proxy URL: it may carry credentials,
 * and its host is internal infrastructure.
 */
import { BlockList, isIP } from 'node:net';
import { AgentConfigError, isLoopbackHost } from './config';

export type ProxySource = 'config' | 'environment' | 'none';

export interface ProxyCredentials {
  username: string;
  password: string;
}

export interface ProxyEndpoint {
  /** scheme://host:port with NO user info, safe to hand to the HTTP client. */
  uri: string;
  protocol: 'http:' | 'https:';
  credentials: ProxyCredentials | null;
}

/** The file-config shape (config-file.ts validates it into this). */
export type FileProxyConfig = 'none' | { url: string; noProxy?: string[] };

type NoProxyRule =
  | { kind: 'all' }
  | { kind: 'local' }
  | { kind: 'domain'; domain: string; port: number | null }
  | { kind: 'address'; list: BlockList; port: number | null };

export interface ProxySettings {
  source: ProxySource;
  httpProxy: ProxyEndpoint | null;
  httpsProxy: ProxyEndpoint | null;
  noProxy: readonly NoProxyRule[];
  /** Human-safe warnings to log once at startup (no hosts, no credentials). */
  warnings: readonly string[];
}

const DIRECT: ProxySettings = { source: 'none', httpProxy: null, httpsProxy: null, noProxy: [], warnings: [] };

const MAX_CREDENTIAL_LENGTH = 1024;

/**
 * Validates a proxy URL. `label` names the setting in error messages (e.g.
 * '"proxy.url" in config.json' or 'HTTPS_PROXY'); the value itself is never
 * included. A scheme-less "host:port" is treated as http:// (curl's rule).
 */
export function parseProxyUrl(raw: string, opts: { label: string; allowCredentials: boolean }): ProxyEndpoint {
  const trimmed = raw.trim();
  if (!trimmed) throw new AgentConfigError(`${opts.label} is empty.`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new AgentConfigError(`${opts.label} is not a valid proxy URL. Use http://host:port or https://host:port.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AgentConfigError(`${opts.label} must use http:// or https://. SOCKS and other proxy types are not supported.`);
  }
  if (!u.hostname) throw new AgentConfigError(`${opts.label} has no host name.`);
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new AgentConfigError(`${opts.label} must be just scheme://host:port, with no path, query or fragment.`);
  }

  let credentials: ProxyCredentials | null = null;
  if (u.username || u.password) {
    if (!opts.allowCredentials) {
      throw new AgentConfigError(
        `${opts.label} must not contain a user name or password: config.json is readable by every local user. ` +
          'Put proxy credentials in proxy-credentials.json in the Gateway state directory instead (see the Gateway README).',
      );
    }
    let username: string;
    let password: string;
    try {
      username = decodeURIComponent(u.username);
      password = decodeURIComponent(u.password);
    } catch {
      throw new AgentConfigError(`${opts.label} contains badly encoded user info.`);
    }
    credentials = validateProxyCredentials({ username, password }, opts.label);
  }

  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { uri: `${u.protocol}//${u.hostname}:${port}`, protocol: u.protocol, credentials };
}

/** Basic authentication only: the user name must not contain ':' (RFC 7617). */
export function validateProxyCredentials(c: { username: unknown; password: unknown }, label: string): ProxyCredentials {
  if (typeof c.username !== 'string' || c.username.length === 0 || c.username.length > MAX_CREDENTIAL_LENGTH) {
    throw new AgentConfigError(`${label}: the proxy user name must be a non-empty string.`);
  }
  if (c.username.includes(':')) {
    throw new AgentConfigError(`${label}: the proxy user name must not contain ':' (Basic authentication).`);
  }
  if (typeof c.password !== 'string' || c.password.length > MAX_CREDENTIAL_LENGTH) {
    throw new AgentConfigError(`${label}: the proxy password must be a string.`);
  }
  if (/[\r\n]/.test(c.username) || /[\r\n]/.test(c.password)) {
    throw new AgentConfigError(`${label}: proxy credentials must not contain line breaks.`);
  }
  return { username: c.username, password: c.password };
}

function parsePort(raw: string, label: string): number {
  const n = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || n < 1 || n > 65535) throw new AgentConfigError(`${label} contains an entry with an invalid port.`);
  return n;
}

const HOST_LABEL = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/**
 * NO_PROXY grammar (documented in agent/README.md):
 *   - entries separated by commas and/or whitespace; matching is case-insensitive;
 *   - "*" alone bypasses the proxy for everything;
 *   - "<local>" (the Windows proxy-bypass token) matches dot-less host names;
 *   - "example.com", ".example.com" and "*.example.com" all match example.com
 *     and every subdomain of it;
 *   - an IPv4/IPv6 address, or a CIDR range ("10.0.0.0/8", "fd00::/8"),
 *     matches destinations written as that literal address (no DNS lookups);
 *   - an optional ":port" (IPv6: "[addr]:port") limits the entry to that port.
 */
export function parseNoProxy(raw: string | readonly string[], label: string): NoProxyRule[] {
  const entries = (typeof raw === 'string' ? raw.split(/[\s,]+/) : raw.flatMap((e) => e.split(/[\s,]+/)))
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  const rules: NoProxyRule[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      rules.push({ kind: 'all' });
      continue;
    }
    if (entry === '<local>') {
      rules.push({ kind: 'local' });
      continue;
    }

    let host = entry;
    let port: number | null = null;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      host = bracketed[1]!;
      if (bracketed[2] !== undefined) port = parsePort(bracketed[2], label);
    } else if (!entry.includes('/') && (entry.match(/:/g) ?? []).length === 1) {
      const [h, p] = entry.split(':');
      host = h!;
      port = parsePort(p!, label);
    }

    const cidr = /^(.+)\/(\d{1,3})$/.exec(host);
    if (cidr) {
      const family = isIP(cidr[1]!);
      const prefix = Number(cidr[2]);
      if (!family || prefix > (family === 4 ? 32 : 128)) throw new AgentConfigError(`${label} contains an invalid CIDR range.`);
      const list = new BlockList();
      list.addSubnet(cidr[1]!, prefix, family === 4 ? 'ipv4' : 'ipv6');
      rules.push({ kind: 'address', list, port });
      continue;
    }

    const family = isIP(host);
    if (family) {
      const list = new BlockList();
      list.addAddress(host, family === 4 ? 'ipv4' : 'ipv6');
      rules.push({ kind: 'address', list, port });
      continue;
    }

    const domain = host.replace(/^\*?\./, '').replace(/\.$/, '');
    if (!HOST_LABEL.test(domain)) throw new AgentConfigError(`${label} contains an entry that is not a host name, address or CIDR range.`);
    rules.push({ kind: 'domain', domain, port });
  }
  return rules;
}

function bareHostname(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

export function matchesNoProxy(target: URL, rules: readonly NoProxyRule[]): boolean {
  const host = bareHostname(target);
  const port = effectivePort(target);
  const family = isIP(host);
  for (const rule of rules) {
    if (rule.kind === 'all') return true;
    if (rule.kind === 'local') {
      if (!family && !host.includes('.')) return true;
      continue;
    }
    if (rule.port !== null && rule.port !== port) continue;
    if (rule.kind === 'domain') {
      if (!family && (host === rule.domain || host.endsWith(`.${rule.domain}`))) return true;
    } else if (family && rule.list.check(host, family === 4 ? 'ipv4' : 'ipv6')) {
      return true;
    }
  }
  return false;
}

function isLoopbackTarget(host: string): boolean {
  return isLoopbackHost(host) || host.endsWith('.localhost') || host === '0:0:0:0:0:0:0:1';
}

/**
 * The proxy for one destination, or null for a direct connection. Loopback
 * is always direct; NO_PROXY exclusions are direct; otherwise the proxy for
 * the destination's scheme.
 */
export function selectProxy(settings: ProxySettings, targetUrl: string | URL): ProxyEndpoint | null {
  const target = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (isLoopbackTarget(bareHostname(target))) return null;
  if (matchesNoProxy(target, settings.noProxy)) return null;
  return target.protocol === 'https:' ? settings.httpsProxy : settings.httpProxy;
}

function envValue(env: NodeJS.ProcessEnv, name: string): { value: string; label: string } | null {
  const lower = env[name.toLowerCase()];
  if (lower !== undefined && lower.trim() !== '') return { value: lower, label: name.toLowerCase() };
  const upper = env[name];
  if (upper !== undefined && upper.trim() !== '') return { value: upper, label: name };
  return null;
}

/**
 * Applies the precedence rules above. `fileCredentials` (from
 * proxy-credentials.json, see proxy-credentials.ts) is used only with a
 * config.json proxy; environment proxies carry their own user info.
 */
export function resolveProxySettings(
  fileProxy: FileProxyConfig | undefined,
  env: NodeJS.ProcessEnv,
  fileCredentials: ProxyCredentials | null = null,
): ProxySettings {
  if (fileProxy === 'none') {
    return { ...DIRECT, warnings: environmentProxyIgnoredWarning(env, 'config.json sets "proxy": "none"') };
  }

  if (fileProxy) {
    const endpoint = parseProxyUrl(fileProxy.url, { label: '"proxy.url" in config.json', allowCredentials: false });
    const withCreds: ProxyEndpoint = { ...endpoint, credentials: fileCredentials };
    return {
      source: 'config',
      httpProxy: withCreds,
      httpsProxy: withCreds,
      noProxy: parseNoProxy(fileProxy.noProxy ?? [], '"proxy.noProxy" in config.json'),
      warnings: environmentProxyIgnoredWarning(env, 'config.json sets "proxy"'),
    };
  }

  if (fileCredentials) {
    // Credentials with no config.json proxy to use them: say so rather than
    // silently doing nothing with them.
    const settings = resolveFromEnvironment(env);
    return {
      ...settings,
      warnings: [...settings.warnings, 'proxy-credentials.json is present but config.json has no "proxy" setting, so it is not used.'],
    };
  }
  return resolveFromEnvironment(env);
}

function resolveFromEnvironment(env: NodeJS.ProcessEnv): ProxySettings {
  const https = envValue(env, 'HTTPS_PROXY');
  const http = envValue(env, 'HTTP_PROXY');
  if (!https && !http) return DIRECT;

  const httpsProxy = https ? parseProxyUrl(https.value, { label: https.label, allowCredentials: true }) : null;
  const httpProxy = http ? parseProxyUrl(http.value, { label: http.label, allowCredentials: true }) : null;
  const noProxyVar = envValue(env, 'NO_PROXY');
  const warnings: string[] = [];
  if (!httpsProxy) {
    warnings.push(
      `${http!.label} is set but HTTPS_PROXY is not, so https:// requests to DPDP connect DIRECTLY ` +
        '(curl/Node.js convention). Set HTTPS_PROXY, or "proxy" in config.json, if they must use the proxy.',
    );
  }
  return {
    source: 'environment',
    httpProxy,
    httpsProxy,
    noProxy: noProxyVar ? parseNoProxy(noProxyVar.value, noProxyVar.label) : [],
    warnings,
  };
}

function environmentProxyIgnoredWarning(env: NodeJS.ProcessEnv, reason: string): string[] {
  const present = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((n) => envValue(env, n));
  return present.length ? [`${reason}, so the ${present.join('/')} environment variable(s) are ignored.`] : [];
}
