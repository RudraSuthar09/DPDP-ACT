/**
 * Agent network configuration — from ENVIRONMENT, never hard-coded addresses.
 *
 * Three SEPARATE network concepts, deliberately not conflated:
 *   1. Bind address   (GATEWAY_BIND_HOST / GATEWAY_BIND_PORT) — where THIS agent
 *      listens for the browser/application.
 *   2. Origin allowlist (GATEWAY_ALLOWED_ORIGINS) — which web origins may talk to
 *      the agent. Exact match only.
 *   3. Control plane   (GATEWAY_CONTROL_PLANE_URL) — where the agent will later
 *      reach the central DPDP backend (NOT connected in Phase 3B).
 *
 * Secure defaults: bind host defaults to loopback (GATEWAY_LOOPBACK_HOST) and the
 * origin allowlist defaults to EMPTY. The agent NEVER auto-defaults to 0.0.0.0.
 * An administrator may explicitly configure a non-loopback address; when they do,
 * the agent detects and reports it (networkMode = 'non-loopback') and must never
 * be silently exposed to a network interface.
 */
import { GATEWAY_LOOPBACK_HOST } from '@dpdp/shared';

export const DEFAULT_BIND_PORT = 7071;

export type NetworkMode = 'loopback' | 'non-loopback';

export interface AgentConfig {
  bindHost: string;
  bindPort: number;
  /** Exact origins allowed to call the agent. Empty until configured. */
  allowedOrigins: readonly string[];
  /** Where the agent will reach Azure/the DPDP control plane later. Not used in 3B. */
  controlPlaneUrl: string | null;
  /** Derived from bindHost — 'non-loopback' the moment it is not a loopback addr. */
  networkMode: NetworkMode;
}

/** Raised for any invalid configuration. The message never contains a secret. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/** Loopback = 127.0.0.0/8, ::1, or the literal 'localhost'. Everything else —
 *  including 0.0.0.0 and any LAN/public address — is non-loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  );
}

function isIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  try {
    return new URL(`http://[${host}]`).hostname.length > 0;
  } catch {
    return false;
  }
}

function isHostname(host: string): boolean {
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    host,
  );
}

/** A syntactically valid bind host: IPv4, IPv6, or a DNS hostname. Rejects '*',
 *  whitespace, empty, and garbage — so "invalid bind address" fails loudly. */
export function isValidBindHost(host: string): boolean {
  if (!host || /\s/.test(host) || host.includes('*')) return false;
  // A dotted/numeric-only string must be a valid IPv4 — this rejects things like
  // '1.2.3.4.5' or '999.1.1.1' that would otherwise pass the hostname grammar.
  if (/^[\d.]+$/.test(host)) return isIpv4(host);
  return isIpv6(host) || isHostname(host);
}

/** An exact origin: scheme://host[:port], nothing more. No path, no wildcard. */
export function isExactOrigin(origin: string): boolean {
  return /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(origin);
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const entries = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  for (const entry of entries) {
    if (entry.includes('*')) {
      throw new AgentConfigError(
        'GATEWAY_ALLOWED_ORIGINS must not contain a wildcard "*". List exact origins only.',
      );
    }
    if (!isExactOrigin(entry)) {
      throw new AgentConfigError(
        `GATEWAY_ALLOWED_ORIGINS contains an invalid origin. Each must be scheme://host[:port].`,
      );
    }
  }
  return entries;
}

/**
 * Build the agent config from an env-like map (defaults to process.env). Pure and
 * total: it either returns a valid config or throws AgentConfigError. It performs
 * NO I/O and opens NO socket — creating/listening is the server's job.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const bindHost = (env.GATEWAY_BIND_HOST ?? GATEWAY_LOOPBACK_HOST).trim();
  if (!isValidBindHost(bindHost)) {
    throw new AgentConfigError('GATEWAY_BIND_HOST is not a valid IP address or hostname.');
  }

  const portRaw = env.GATEWAY_BIND_PORT;
  const bindPort = portRaw === undefined || portRaw === '' ? DEFAULT_BIND_PORT : Number(portRaw);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) {
    throw new AgentConfigError('GATEWAY_BIND_PORT must be an integer between 1 and 65535.');
  }

  const allowedOrigins = parseAllowedOrigins(env.GATEWAY_ALLOWED_ORIGINS);

  let controlPlaneUrl: string | null = null;
  const cp = env.GATEWAY_CONTROL_PLANE_URL?.trim();
  if (cp) {
    try {
      const u = new URL(cp);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      controlPlaneUrl = cp;
    } catch {
      throw new AgentConfigError('GATEWAY_CONTROL_PLANE_URL must be a valid http(s) URL.');
    }
  }

  return {
    bindHost,
    bindPort,
    allowedOrigins,
    controlPlaneUrl,
    networkMode: isLoopbackHost(bindHost) ? 'loopback' : 'non-loopback',
  };
}
